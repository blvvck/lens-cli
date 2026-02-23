import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock, resetChromeMock } from "../../mocks/chrome";

vi.mock("../../../src/native/port", () => ({
  initNativeMessaging: vi.fn(),
  postToNativeHost: vi.fn(),
}));

let handleMessage: (message: any, sender: any) => Promise<any>;

beforeAll(async () => {
  (globalThis as any).chrome = createChromeMock();
  handleMessage = (await import("../../../src/service-worker/main")).handleMessage;
});

describe("fetch interception command dispatch", () => {
  beforeEach(() => {
    (globalThis as any).chrome = createChromeMock();
  });

  afterEach(() => {
    resetChromeMock();
  });

  it("manages serve routes and intercept rules through dispatch", async () => {
    await expect(
      handleMessage({ type: "lens.serve.start", dir: "/first", port: 9000 }, {}),
    ).resolves.toEqual({
      success: true,
      url: "http://lens.local:9000/",
      dir: "/first",
    });
    await handleMessage({ type: "lens.serve.start", dir: "/second", port: 9000 }, {});
    await expect(
      handleMessage(
        {
          type: "lens.intercept.add",
          pattern: "https://example.com/api/*",
          ruleType: "mock",
          response: "ok",
          status: 201,
          delayMs: 25,
          fileContent: "body",
          contentType: "text/plain",
        },
        {},
      ),
    ).resolves.toEqual({
      success: true,
      pattern: "https://example.com/api/*",
      type: "mock",
    });

    await expect(handleMessage({ type: "lens.serve.status" }, {})).resolves.toEqual({
      success: true,
      serveRoutes: [{ urlPrefix: "http://lens.local:9000/", localDir: "/second" }],
      interceptRules: [{ pattern: "https://example.com/api/*", type: "mock" }],
    });
    await expect(handleMessage({ type: "lens.intercept.list" }, {})).resolves.toEqual({
      success: true,
      serveRoutes: [{ urlPrefix: "http://lens.local:9000/", localDir: "/second" }],
      interceptRules: [{ pattern: "https://example.com/api/*", type: "mock" }],
    });

    await expect(
      handleMessage({ type: "lens.intercept.remove", pattern: "https://example.com/missing" }, {}),
    ).resolves.toEqual({ success: true, removed: false });
    await expect(
      handleMessage({ type: "lens.intercept.remove", pattern: "https://example.com/api/*" }, {}),
    ).resolves.toEqual({ success: true, removed: true });
    await expect(handleMessage({ type: "lens.serve.stop", port: 9000 }, {})).resolves.toEqual({
      success: true,
      removed: true,
    });
    await handleMessage({ type: "lens.intercept.clear" }, {});
    await expect(handleMessage({ type: "lens.intercept.list" }, {})).resolves.toEqual({
      success: true,
      serveRoutes: [],
      interceptRules: [],
    });
  });

  it("validates required directories and patterns", async () => {
    await expect(handleMessage({ type: "lens.serve.start" }, {})).rejects.toThrow(
      "No directory provided",
    );
    await expect(handleMessage({ type: "lens.intercept.add" }, {})).rejects.toThrow(
      "No pattern provided",
    );
    await expect(handleMessage({ type: "lens.intercept.remove" }, {})).rejects.toThrow(
      "No pattern provided",
    );
  });
});
