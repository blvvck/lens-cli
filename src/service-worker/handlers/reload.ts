import type { ServiceWorkerHandlerMap } from "../shared";

type SnapshotNode = {
  tag: string;
  role?: string;
  text?: string;
  bounds: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  attrs?: Record<string, string>;
  children: SnapshotNode[];
};

function colorDifference(a: Uint8ClampedArray, b: Uint8ClampedArray, aOffset: number, bOffset: number, luminanceOnly = false) {
  const alphaA = a[aOffset + 3];
  const alphaB = b[bOffset + 3];
  let red = a[aOffset] - b[bOffset];
  let green = a[aOffset + 1] - b[bOffset + 1];
  let blue = a[aOffset + 2] - b[bOffset + 2];
  const alphaDelta = alphaA - alphaB;
  if (!red && !green && !blue && !alphaDelta) return 0;
  if (alphaA < 255 || alphaB < 255) {
    const pixel = aOffset / 4;
    const backgrounds = [
      48 + 159 * (pixel % 2),
      48 + 159 * ((pixel / 1.618033988749895 | 0) % 2),
      48 + 159 * ((pixel / 2.618033988749895 | 0) % 2),
    ];
    red = (a[aOffset] * alphaA - b[bOffset] * alphaB - backgrounds[0] * alphaDelta) / 255;
    green = (a[aOffset + 1] * alphaA - b[bOffset + 1] * alphaB - backgrounds[1] * alphaDelta) / 255;
    blue = (a[aOffset + 2] * alphaA - b[bOffset + 2] * alphaB - backgrounds[2] * alphaDelta) / 255;
  }
  const y = red * 0.29889531 + green * 0.58662247 + blue * 0.11448223;
  if (luminanceOnly) return y;
  const i = red * 0.59597799 - green * 0.2741761 - blue * 0.32180189;
  const q = red * 0.21147017 - green * 0.52261711 + blue * 0.31114694;
  const distance = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  return y > 0 ? -distance : distance;
}

function hasNeighborConsensus(pixels: Uint32Array, x: number, y: number, width: number, height: number) {
  const left = Math.max(x - 1, 0);
  const right = Math.min(x + 1, width - 1);
  const top = Math.max(y - 1, 0);
  const bottom = Math.min(y + 1, height - 1);
  const color = pixels[y * width + x];
  let matches = x === left || x === right || y === top || y === bottom ? 1 : 0;
  for (let column = left; column <= right; column++) {
    for (let row = top; row <= bottom; row++) {
      if (column === x && row === y) continue;
      matches += Number(pixels[row * width + column] === color);
      if (matches > 2) return true;
    }
  }
  return false;
}

function isSmoothingPixel(
  pixels: Uint8ClampedArray,
  x: number,
  y: number,
  width: number,
  height: number,
  original: Uint32Array,
  comparison: Uint32Array,
) {
  const left = Math.max(x - 1, 0);
  const right = Math.min(x + 1, width - 1);
  const top = Math.max(y - 1, 0);
  const bottom = Math.min(y + 1, height - 1);
  const center = y * width + x;
  let flat = x === left || x === right || y === top || y === bottom ? 1 : 0;
  let low = 0;
  let high = 0;
  let lowX = 0;
  let lowY = 0;
  let highX = 0;
  let highY = 0;
  for (let column = left; column <= right; column++) {
    for (let row = top; row <= bottom; row++) {
      if (column === x && row === y) continue;
      const position = row * width + column;
      const slope = colorDifference(pixels, pixels, center * 4, position * 4, true);
      if (slope === 0) {
        flat++;
        if (flat > 2) return false;
      } else if (slope < low) {
        low = slope;
        lowX = column;
        lowY = row;
      } else if (slope > high) {
        high = slope;
        highX = column;
        highY = row;
      }
    }
  }
  if (!low || !high) return false;
  return (hasNeighborConsensus(original, lowX, lowY, width, height) &&
    hasNeighborConsensus(comparison, lowX, lowY, width, height)) ||
    (hasNeighborConsensus(original, highX, highY, width, height) &&
      hasNeighborConsensus(comparison, highX, highY, width, height));
}

export const reloadHandlers: ServiceWorkerHandlerMap = {
  "extension.reload": async () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true };
  },
  "lens.page.domDiff": async (message) => {
    const first = message.snapshotA as { tree?: SnapshotNode; viewport?: unknown } | undefined;
    const second = message.snapshotB as { tree?: SnapshotNode; viewport?: unknown } | undefined;
    if (!first?.tree || !second?.tree) throw new Error("Two snapshots required");
    const changes: Array<{ type: "added" | "removed" | "changed" | "moved"; path: string; tag: string; details: string }> = [];
    const keyOf = (node: SnapshotNode) => node.attrs?.id ? `#${node.attrs.id}`
      : node.attrs?.class ? `${node.tag}.${node.attrs.class.split(" ").slice(0, 2).join(".")}`
        : node.text ? `${node.tag}:"${node.text.substring(0, 30)}"` : node.tag;
    const compare = (a: SnapshotNode, b: SnapshotNode, path: string, index: number) => {
      const here = `${path}${path ? " > " : ""}${a.tag}[${index}]`;
      if (a.text !== b.text) changes.push({ type: "changed", path: here, tag: a.tag,
        details: `text: ${a.text ? `"${a.text.substring(0, 50)}"` : "(empty)"} → ${b.text ? `"${b.text.substring(0, 50)}"` : "(empty)"}` });
      const bounds = a.bounds;
      const next = b.bounds;
      const moved = Math.abs(bounds.x - next.x) > 2 || Math.abs(bounds.y - next.y) > 2;
      const resized = Math.abs(bounds.w - next.w) > 2 || Math.abs(bounds.h - next.h) > 2;
      if (moved || resized) {
        const parts = [];
        if (moved) parts.push(`pos: ${bounds.x},${bounds.y} → ${next.x},${next.y}`);
        if (resized) parts.push(`size: ${bounds.w}x${bounds.h} → ${next.w}x${next.h}`);
        changes.push({ type: "moved", path: here, tag: a.tag, details: parts.join("; ") });
      }
      const styleKeys = new Set([...Object.keys(a.styles), ...Object.keys(b.styles)]);
      const styleDiff = [...styleKeys].flatMap((name) => a.styles[name] === b.styles[name] ? []
        : [!a.styles[name] ? `+${name}: ${b.styles[name]}` : !b.styles[name] ? `-${name}: ${a.styles[name]}` : `${name}: ${a.styles[name]} → ${b.styles[name]}`]);
      if (styleDiff.length) changes.push({ type: "changed", path: here, tag: a.tag, details: styleDiff.join("; ") });
      const matched = new Set<number>();
      a.children.forEach((child, childIndex) => {
        const found = b.children.findIndex((candidate, i) => !matched.has(i) && keyOf(candidate) === keyOf(child));
        if (found < 0) changes.push({ type: "removed", path: `${here} > ${child.tag}[${childIndex}]`, tag: child.tag, details: keyOf(child) });
        else { matched.add(found); compare(child, b.children[found], here, childIndex); }
      });
      b.children.forEach((child, childIndex) => {
        if (!matched.has(childIndex)) changes.push({ type: "added", path: `${here} > ${child.tag}[${childIndex}]`, tag: child.tag, details: keyOf(child) });
      });
    };
    compare(first.tree, second.tree, "", 0);
    return {
      changes,
      summary: {
        total: changes.length,
        added: changes.filter((change) => change.type === "added").length,
        removed: changes.filter((change) => change.type === "removed").length,
        changed: changes.filter((change) => change.type === "changed").length,
        moved: changes.filter((change) => change.type === "moved").length,
      },
      viewportA: first.viewport,
      viewportB: second.viewport,
    };
  },
  "lens.page.diff": async (message) => {
    let width: number;
    let height: number;
    let a: Uint8ClampedArray;
    let b: Uint8ClampedArray;
    if (message.rawA && message.rawB) {
      if (message.width === undefined || message.height === undefined) throw new Error("Raw buffer mode requires width and height");
      width = message.width;
      height = message.height;
      const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      const rawA = decode(message.rawA);
      const rawB = decode(message.rawB);
      const bytes = width * height * 4;
      if (rawA.length !== bytes) throw new Error(`rawA size mismatch: expected ${bytes} bytes (${width}x${height}x4), got ${rawA.length}`);
      if (rawB.length !== bytes) throw new Error(`rawB size mismatch: expected ${bytes} bytes (${width}x${height}x4), got ${rawB.length}`);
      a = new Uint8ClampedArray(rawA);
      b = new Uint8ClampedArray(rawB);
    } else if (message.base64A && message.base64B) {
      const load = async (value: string) => createImageBitmap(new Blob([Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
      const [imageA, imageB] = await Promise.all([load(message.base64A), load(message.base64B)]);
      if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
        const reason = `Image dimensions must match. Got ${imageA.width}x${imageA.height} vs ${imageB.width}x${imageB.height}. Capture both screenshots at the same viewport size.`;
        imageA.close(); imageB.close(); throw new Error(reason);
      }
      width = imageA.width; height = imageA.height;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d")!;
      context.drawImage(imageA, 0, 0);
      a = context.getImageData(0, 0, width, height).data;
      context.clearRect(0, 0, width, height);
      context.drawImage(imageB, 0, 0);
      b = context.getImageData(0, 0, width, height).data;
      imageA.close(); imageB.close();
    } else {
      throw new Error("Two images required: either base64A/base64B (PNG) or rawA/rawB + width/height (RGBA buffers)");
    }
    const totalPixels = width * height;
    const threshold = message.threshold ?? 0.1;
    const maxDelta = 35215 * threshold * threshold;
    const outputCanvas = new OffscreenCanvas(width, height);
    const context = outputCanvas.getContext("2d")!;
    const output = context.createImageData(width, height);
    const base64Png = async () => {
      const blob = await outputCanvas.convertToBlob({ type: "image/png" });
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = () => reject(new Error("Failed to convert blob to base64"));
        reader.readAsDataURL(blob);
      });
    };
    let differences = 0;
    if ((message.mode || "pixel") === "ssim") {
      const windowSize = message.ssimWindow || 11;
      const radius = Math.floor(windowSize / 2);
      const luminanceA = new Float32Array(totalPixels);
      const luminanceB = new Float32Array(totalPixels);
      for (let pixel = 0; pixel < totalPixels; pixel++) {
        const offset = pixel * 4;
        luminanceA[pixel] = a[offset] * 0.299 + a[offset + 1] * 0.587 + a[offset + 2] * 0.114;
        luminanceB[pixel] = b[offset] * 0.299 + b[offset + 1] * 0.587 + b[offset + 2] * 0.114;
      }
      const similarityMap = new Float32Array(totalPixels);
      similarityMap.fill(1);
      let similarityTotal = 0;
      let windows = 0;
      const luminance = 255;
      const lightConstant = (0.01 * luminance) ** 2;
      const contrastConstant = (0.03 * luminance) ** 2;
      for (let centerY = radius; centerY < height - radius; centerY++) {
        for (let centerX = radius; centerX < width - radius; centerX++) {
          let meanA = 0;
          let meanB = 0;
          for (let y = -radius; y <= radius; y++) {
            for (let x = -radius; x <= radius; x++) {
              const pixel = (centerY + y) * width + centerX + x;
              meanA += luminanceA[pixel];
              meanB += luminanceB[pixel];
            }
          }
          const sampleCount = windowSize * windowSize;
          meanA /= sampleCount;
          meanB /= sampleCount;
          let varianceA = 0;
          let varianceB = 0;
          let covariance = 0;
          for (let y = -radius; y <= radius; y++) {
            for (let x = -radius; x <= radius; x++) {
              const pixel = (centerY + y) * width + centerX + x;
              const deltaA = luminanceA[pixel] - meanA;
              const deltaB = luminanceB[pixel] - meanB;
              varianceA += deltaA * deltaA;
              varianceB += deltaB * deltaB;
              covariance += deltaA * deltaB;
            }
          }
          varianceA /= sampleCount - 1;
          varianceB /= sampleCount - 1;
          covariance /= sampleCount - 1;
          const top = (2 * meanA * meanB + lightConstant) * (2 * covariance + contrastConstant);
          const bottom = (meanA ** 2 + meanB ** 2 + lightConstant) *
            (varianceA + varianceB + contrastConstant);
          const score = top / bottom;
          similarityMap[centerY * width + centerX] = score;
          similarityTotal += score;
          windows++;
        }
      }
      const meanSimilarity = windows ? similarityTotal / windows : 1;
      const similarity = Math.round(meanSimilarity * 10000) / 10000;
      for (let pixel = 0; pixel < totalPixels; pixel++) {
        const offset = pixel * 4;
        const localScore = Math.max(0, Math.min(1, similarityMap[pixel]));
        if (localScore >= 0.95) {
          if (!message.diffMask) {
            const gray = 255 + (a[offset] * 0.29889531 + a[offset + 1] * 0.58662247 +
              a[offset + 2] * 0.11448223 - 255) * (message.alpha ?? 0.1) * a[offset + 3] / 255;
            output.data.set([gray, gray, gray, 255], offset);
          }
        } else {
          const intensity = (0.95 - localScore) / 0.95;
          const red = intensity < 0.5 ? Math.floor(510 * intensity) : 255;
          const green = intensity < 0.5 ? 255 : Math.floor(510 * (1 - intensity));
          output.data.set([red, green, 0, 255], offset);
        }
      }
      context.putImageData(output, 0, 0);
      return {
        base64: await base64Png(),
        width,
        height,
        mode: "ssim",
        ssim: similarity,
        mssim: similarity,
        totalPixels,
        passed: meanSimilarity >= (message.passThreshold ?? 0.95),
      };
    }
    const pixelsA = new Uint32Array(a.buffer, a.byteOffset, totalPixels);
    const pixelsB = new Uint32Array(b.buffer, b.byteOffset, totalPixels);
    const antiAliasColor = message.aaColor || [255, 255, 0];
    const primaryColor = message.diffColor || [255, 0, 0];
    const darkerColor = message.diffColorAlt || primaryColor;
    let antiAliasCount = 0;
    for (let pixel = 0; pixel < totalPixels; pixel++) {
      const offset = pixel * 4;
      const delta = pixelsA[pixel] === pixelsB[pixel] ? 0 : colorDifference(a, b, offset, offset);
      if (Math.abs(delta) > maxDelta) {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const antiAliased = !message.includeAA &&
          (isSmoothingPixel(a, x, y, width, height, pixelsA, pixelsB) ||
            isSmoothingPixel(b, x, y, width, height, pixelsB, pixelsA));
        if (antiAliased) {
          antiAliasCount++;
          if (!message.diffMask) output.data.set([...antiAliasColor, 255], offset);
        } else {
          differences++;
          output.data.set([...(delta < 0 ? darkerColor : primaryColor), 255], offset);
        }
      } else if (!message.diffMask) {
        const gray = 255 + (a[offset] * 0.29889531 + a[offset + 1] * 0.58662247 + a[offset + 2] * 0.11448223 - 255) * (message.alpha ?? 0.1) * a[offset + 3] / 255;
        output.data.set([gray, gray, gray, 255], offset);
      }
    }
    context.putImageData(output, 0, 0);
    const mismatchPct = totalPixels > 0 ? differences / totalPixels * 100 : 0;
    return { base64: await base64Png(), width, height,
      mismatch: Math.round(mismatchPct * 100) / 100,
      mismatchPixels: differences,
      totalPixels,
      aaPixels: antiAliasCount,
      passed: mismatchPct <= (message.passThreshold ?? 0) };
  },
};
