/**
 * Canvas content extraction via 2D rendering API interception.
 *
 * Canvas apps (Whimsical, Excalidraw, Miro, tldraw) render everything through
 * CanvasRenderingContext2D method calls — fillText, strokeText, fillRect, etc.
 * This module intercepts those calls to build a structured content tree from
 * what would otherwise be opaque pixels.
 *
 * The interceptor is injected via CDP Runtime.evaluate into the page context,
 * wraps the Canvas 2D prototype methods, waits for a re-render frame, then
 * collects and returns all captured draw operations.
 */

import { cdp, type ServiceWorkerHandlerMap } from "../shared";

/**
 * The script injected into the page context via CDP.
 * It wraps Canvas 2D text methods, triggers a re-render, and returns
 * all captured text nodes with absolute positions.
 */
export const CANVAS_REDRAW_WAIT_SCRIPT = `new Promise(resolve => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  const timeout = setTimeout(finish, 250);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timeout);
    finish();
  }));
})`;

const CANVAS_TEXT_INTERCEPTOR = `(async function() {
  // ── Detect canvas elements ─────────────────────────────────────────
  const canvases = Array.from(document.querySelectorAll('canvas'));
  if (canvases.length === 0) return { canvasDetected: false, textNodes: [], count: 0 };

  const totalArea = canvases.reduce((sum, c) => sum + c.width * c.height, 0);
  if (totalArea < 10000) return { canvasDetected: false, textNodes: [], count: 0 };

  // ── State ──────────────────────────────────────────────────────────
  const captured = [];
  let frameId = 0;

  // ── Wrap fillText / strokeText ─────────────────────────────────────
  const proto = CanvasRenderingContext2D.prototype;
  const origFillText = proto.fillText;
  const origStrokeText = proto.strokeText;
  const origClearRect = proto.clearRect;

  // Track full-canvas clears to know when a new frame starts
  proto.clearRect = function(x, y, w, h) {
    if (w >= this.canvas.width * 0.9 && h >= this.canvas.height * 0.9) {
      frameId++;
    }
    return origClearRect.call(this, x, y, w, h);
  };

  proto.fillText = function(text, x, y, maxWidth) {
    try {
      const t = this.getTransform();
      captured.push({
        text: String(text),
        x: t.a * x + t.c * y + t.e,
        y: t.b * x + t.d * y + t.f,
        font: this.font,
        color: String(this.fillStyle),
        alpha: this.globalAlpha,
        frame: frameId,
        method: 'fill'
      });
    } catch {}
    return origFillText.call(this, text, x, y, maxWidth);
  };

  proto.strokeText = function(text, x, y, maxWidth) {
    try {
      const t = this.getTransform();
      captured.push({
        text: String(text),
        x: t.a * x + t.c * y + t.e,
        y: t.b * x + t.d * y + t.f,
        font: this.font,
        color: String(this.strokeStyle),
        alpha: this.globalAlpha,
        frame: frameId,
        method: 'stroke'
      });
    } catch {}
    return origStrokeText.call(this, text, x, y, maxWidth);
  };

  // ── Trigger re-render ──────────────────────────────────────────────
  // Most canvas apps re-render on resize or animation frame.
  window.dispatchEvent(new Event('resize'));

  // Wait two animation frames to capture the re-render
  await (${CANVAS_REDRAW_WAIT_SCRIPT});

  // If nothing was captured, do not touch the canvas: assigning to width clears
  // the bitmap, and an app that does not redraw would be left blank. A miss here
  // is reported instead.

  // ── Restore prototypes ─────────────────────────────────────────────
  proto.fillText = origFillText;
  proto.strokeText = origStrokeText;
  proto.clearRect = origClearRect;

  // ── Process captured text ──────────────────────────────────────────
  if (captured.length === 0) {
    return { canvasDetected: true, textNodes: [], count: 0, note: 'Canvas present but no text drawn (may use WebGL or bitmap text)' };
  }

  // Use only the latest frame's draws (handles 60fps redraw spam)
  const lastFrame = Math.max(...captured.map(c => c.frame));
  let frameNodes = captured.filter(c => c.frame === lastFrame);

  // Filter out invisible text (near-zero alpha)
  frameNodes = frameNodes.filter(n => n.alpha > 0.05);

  // ── Stitch single-character draws into words ───────────────────────
  // Some apps draw text character-by-character with custom kerning.
  // Group chars that are on the same baseline and close horizontally.
  frameNodes.sort((a, b) => {
    if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
    return a.y - b.y;
  });

  const stitched = [];
  let current = null;

  for (const node of frameNodes) {
    if (node.text.length <= 1 && current) {
      // Estimate character width from font size
      const fontSize = parseInt(node.font) || 14;
      const charWidth = fontSize * 0.65;
      const sameBaseline = Math.abs(node.y - current.y) < fontSize * 0.3;
      const adjacent = node.x - (current.x + current.text.length * charWidth) < charWidth * 1.5;

      if (sameBaseline && adjacent && node.font === current.font) {
        current.text += node.text;
        continue;
      }
    }

    if (current) stitched.push(current);
    current = { ...node };
  }
  if (current) stitched.push(current);

  // ── Deduplicate ────────────────────────────────────────────────────
  const seen = new Set();
  const unique = stitched.filter(item => {
    const key = item.text + '|' + Math.round(item.x) + '|' + Math.round(item.y);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Sort by visual reading order (top-to-bottom, left-to-right) ───
  unique.sort((a, b) => {
    const fontSize = parseInt(a.font) || 14;
    if (Math.abs(a.y - b.y) < fontSize) return a.x - b.x;
    return a.y - b.y;
  });

  return {
    canvasDetected: true,
    textNodes: unique.map(n => ({
      text: n.text,
      x: Math.round(n.x),
      y: Math.round(n.y),
      font: n.font,
      color: n.color
    })),
    count: unique.length
  };
})()`;

/**
 * Detect if a page is canvas-dominant (large canvas, minimal DOM text).
 */
const CANVAS_DETECTION_SCRIPT = `(() => {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  if (canvases.length === 0) return { isCanvasDominant: false };

  const viewportArea = window.innerWidth * window.innerHeight;
  const canvasArea = canvases.reduce((sum, c) => {
    const rect = c.getBoundingClientRect();
    return sum + rect.width * rect.height;
  }, 0);

  // Canvas covers >40% of viewport
  const canvasRatio = canvasArea / viewportArea;

  // Count VISIBLE text only — exclude script, style, noscript, svg, template
  const excluded = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'LINK', 'META']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      let el = node.parentElement;
      while (el) {
        if (excluded.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let visibleText = '';
  let n;
  while (n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t) visibleText += t + ' ';
  }
  const visibleLength = visibleText.trim().length;

  return {
    isCanvasDominant: canvasRatio > 0.4 && visibleLength < 500,
    canvasCount: canvases.length,
    canvasRatio: Number(canvasRatio.toFixed(2)),
    domTextLength: visibleLength
  };
})()`;

export interface CanvasTextNode {
  text: string;
  x: number;
  y: number;
  font: string;
  color: string;
}

export interface CanvasExtractionResult {
  canvasDetected: boolean;
  textNodes: CanvasTextNode[];
  count: number;
  note?: string;
}

export interface CanvasDetectionResult {
  isCanvasDominant: boolean;
  canvasCount?: number;
  canvasRatio?: number;
  domTextLength?: number;
}

/**
 * Check if the page is canvas-dominant (large canvas, minimal DOM text).
 */
export async function detectCanvasPage(tabId: number): Promise<CanvasDetectionResult> {
  try {
    const result = await cdp.evaluateScript(tabId, CANVAS_DETECTION_SCRIPT);
    return result.result?.value || { isCanvasDominant: false };
  } catch {
    return { isCanvasDominant: false };
  }
}

/**
 * Extract text content from canvas elements by intercepting the 2D drawing API.
 * Wraps fillText/strokeText, triggers a re-render, captures all text draws.
 */
export async function extractCanvasText(tabId: number): Promise<CanvasExtractionResult> {
  try {
    const result = await cdp.evaluateScript(tabId, CANVAS_TEXT_INTERCEPTOR);
    if (result.exceptionDetails) {
      return { canvasDetected: false, textNodes: [], count: 0, note: result.exceptionDetails.text };
    }
    return result.result?.value || { canvasDetected: false, textNodes: [], count: 0 };
  } catch (err) {
    return {
      canvasDetected: false,
      textNodes: [],
      count: 0,
      note: err instanceof Error ? err.message : "Canvas extraction failed",
    };
  }
}

/**
 * Format extracted canvas text nodes into a readable string.
 * Groups by approximate vertical position for natural reading order.
 */
export function formatCanvasText(nodes: CanvasTextNode[]): string {
  if (nodes.length === 0) return "";

  const lines: string[] = [];
  let lastY = -Infinity;

  for (const node of nodes) {
    const fontSize = parseInt(node.font) || 14;
    // New line when Y position changes significantly
    if (node.y - lastY > fontSize * 1.5) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push(""); // blank line between sections
      }
    }
    lines.push(node.text);
    lastY = node.y;
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const canvasHandlers: ServiceWorkerHandlerMap = {
  "canvas.detect": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    return await detectCanvasPage(tabId);
  },

  "canvas.text": async (message) => {
    const tabId = message.tabId;
    if (!tabId) throw new Error("No tabId provided");
    const result = await extractCanvasText(tabId);
    return { ...result, formatted: formatCanvasText(result.textNodes) };
  },
};
