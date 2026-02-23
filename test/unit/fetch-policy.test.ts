import { describe, expect, it } from "vitest";

import * as fetchPolicy from "../../native/runtime/fetch-policy.cjs";

describe("fetch policy", () => {
  it("returns known MIME types for served file extensions", () => {
    expect(fetchPolicy.getMimeType("/tmp/app.html")).toBe("text/html");
    expect(fetchPolicy.getMimeType("/tmp/data.json")).toBe("application/json");
    expect(fetchPolicy.getMimeType("/tmp/image.webp")).toBe("image/webp");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(fetchPolicy.getMimeType("/tmp/archive.unknown")).toBe("application/octet-stream");
  });

  it("matches exact URLs and wildcard patterns", () => {
    expect(fetchPolicy.matchesUrlPattern("https://example.com/api/users", "https://example.com/api/users")).toBe(true);
    expect(fetchPolicy.matchesUrlPattern("https://example.com/api/users", "https://example.com/api/*")).toBe(true);
    expect(fetchPolicy.matchesUrlPattern("https://example.com/assets/app.js", "https://example.com/api/*")).toBe(false);
  });

  it("supports single-character wildcards", () => {
    expect(fetchPolicy.matchesUrlPattern("https://example.com/api/v1", "https://example.com/api/v?")).toBe(true);
    expect(fetchPolicy.matchesUrlPattern("https://example.com/api/v12", "https://example.com/api/v?")).toBe(false);
  });
});
