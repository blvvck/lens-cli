import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCdp } = vi.hoisted(() => ({
  mockCdp: { evaluateScript: vi.fn(), setFetchRequestHandler: vi.fn() },
}));

vi.mock("../../../src/service-worker/shared", () => ({ cdp: mockCdp }));

import {
  CANVAS_REDRAW_WAIT_SCRIPT,
  canvasHandlers,
} from "../../../src/service-worker/handlers/canvas";

describe("canvas handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CANVAS_DETECT reports what the page detection script returns", async () => {
    mockCdp.evaluateScript.mockResolvedValue({
      result: {
        value: { isCanvasDominant: true, canvasCount: 1, canvasRatio: 0.82, domTextLength: 40 },
      },
    });

    const result = await canvasHandlers["canvas.detect"]({ tabId: 123 }, {} as never);

    expect(mockCdp.evaluateScript).toHaveBeenCalledOnce();
    expect(result).toEqual({
      isCanvasDominant: true,
      canvasCount: 1,
      canvasRatio: 0.82,
      domTextLength: 40,
    });
  });

  it("CANVAS_TEXT returns nodes plus a formatted reading order", async () => {
    mockCdp.evaluateScript.mockResolvedValue({
      result: {
        value: {
          canvasDetected: true,
          count: 2,
          textNodes: [
            { text: "Heading", x: 10, y: 20, font: "16px Inter", color: "#111" },
            { text: "Body", x: 10, y: 80, font: "14px Inter", color: "#333" },
          ],
        },
      },
    });

    const result = (await canvasHandlers["canvas.text"]({ tabId: 123 }, {} as never)) as {
      canvasDetected: boolean;
      count: number;
      formatted: string;
    };

    expect(result.canvasDetected).toBe(true);
    expect(result.count).toBe(2);
    expect(result.formatted).toContain("Heading");
    expect(result.formatted).toContain("Body");
  });

  it("bounds redraw waiting so a throttled canvas does not hang the command", async () => {
    vi.useFakeTimers();
    try {
      const waitForRedraw = new Function(
        "requestAnimationFrame",
        "setTimeout",
        "clearTimeout",
        `return (${CANVAS_REDRAW_WAIT_SCRIPT});`,
      );
      let settled = false;
      const promise = waitForRedraw(() => undefined, setTimeout, clearTimeout).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a missing tab instead of asserting on it", async () => {
    await expect(canvasHandlers["canvas.text"]({}, {} as never)).rejects.toThrow(
      "No tabId provided",
    );
    expect(mockCdp.evaluateScript).not.toHaveBeenCalled();
  });
});
