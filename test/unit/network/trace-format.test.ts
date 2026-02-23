// @ts-expect-error - CommonJS module without type definitions
import * as render from "../../../native/network/trace-format.cjs";

describe("network trace rendering", () => {
  it("labels sizes at byte, kilobyte and megabyte scale", () => {
    expect(render.size(undefined)).toBe("-");
    expect(render.size(0)).toBe("0B");
    expect(render.size(1023)).toBe("1023B");
    expect(render.size(1024)).toBe("1.0K");
    expect(render.size(1024 * 1024)).toBe("1.0M");
  });

  it("switches duration units at one second", () => {
    expect(render.ms(null)).toBe("-");
    expect(render.ms(999)).toBe("999ms");
    expect(render.ms(1000)).toBe("1.0s");
  });

  it("shortens content types to a tag", () => {
    expect(render.kind(null)).toBe("-");
    expect(render.kind("application/json")).toBe("json");
    expect(render.kind("image/png")).toBe("img");
    expect(render.kind("application/json; charset=utf-8")).toBe("json");
  });

  it("marks status classes so failures stand out in a list", () => {
    expect(render.status(undefined)).toBe("...");
    expect(render.status(204)).toBe("204");
    expect(render.status(304)).toBe("304→");
    expect(render.status(404)).toBe("404!");
    expect(render.status(503)).toBe("503!!");
  });

  it("builds a runnable curl command and drops hop-by-hop headers", () => {
    const command = render.curl({
      method: "POST",
      url: "https://example.test/api",
      requestHeaders: {
        "Content-Type": "application/json",
        Host: "example.test",
        Connection: "keep-alive",
      },
      requestBody: '{"name":"it\'s"}',
    });

    expect(command).toContain("curl -X POST 'https://example.test/api'");
    expect(command).toContain("-H 'Content-Type: application/json'");
    expect(command).not.toContain("Host:");
    expect(command).not.toContain("Connection:");
    expect(command).toContain("'\\''");
  });

  it("renders a list row per request and a size summary", () => {
    const output = render.list([
      {
        requestId: "1234abcd-0000",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseSize: 2048,
        duration: 40,
        url: "https://example.test/items",
      },
    ]);

    expect(output).toContain("1234abcd");
    expect(output).toContain("GET");
    expect(output).toContain("https://example.test/items");
    expect(output).toContain("Total: 1 requests, 2.0K");
    expect(render.list([])).toBe("No network requests captured");
  });

  it("shows request and response sections in verbose mode", () => {
    const output = render.verbose([
      {
        method: "POST",
        url: "https://example.test/api",
        requestHeaders: { "content-type": "application/json" },
        requestBody: '{"a":1}',
        responseHeaders: { "content-type": "application/json" },
        responseBody: '{"ok":true}',
      },
    ]);

    expect(output).toContain("Request Headers:");
    expect(output).toContain("Request Body:");
    expect(output).toContain("Response Body:");
  });

  it("reports a missing request instead of throwing", () => {
    expect(render.entry(null)).toBe("Request not found");
  });

  it("accepts origins as a list or as a map", () => {
    const fromList = render.origins([
      { origin: "https://a.test", count: 3, totalSize: 1024, lastSeen: 0 },
    ]);
    const fromMap = render.origins({ "https://a.test": { count: 3, size: 1024, lastSeen: 0 } });

    expect(fromList).toContain("https://a.test");
    expect(fromMap).toContain("https://a.test");
    expect(render.origins(null)).toBe("No origins captured");
  });

  it("summarises capture statistics", () => {
    const output = render.stats({
      totalRequests: 7,
      totalSize: 4096,
      uniqueOrigins: 2,
      duration: 1500,
      byMethod: { GET: 6, POST: 1 },
    });

    expect(output).toContain("Total Requests:    7");
    expect(output).toContain("Duration:          1.5s");
    expect(output).toContain("GET");
  });

  it("keeps the raw shape the CLI detects", () => {
    const parsed = JSON.parse(render.raw([{ url: "https://example.test" }]));
    expect(parsed._format).toBe("raw");
    expect(parsed.entries).toHaveLength(1);
  });
});
