import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChromeMock } from "../mocks/chrome";

describe("native port protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).chrome = createChromeMock();
  });

  it("forwards renamed native API stream responses without dispatching browser commands", async () => {
    const protocol = await import("../../src/native/port/protocol");
    const { nativeApiFetch } = await import("../../src/native/native-api-transport");
    const postMessage = vi.fn();
    protocol.setNativePort({ postMessage } as any);
    const dispatch = vi.fn().mockResolvedValue({});
    protocol.setMessageHandler(dispatch);
    const onStart = vi.fn();
    const onChunk = vi.fn();
    await nativeApiFetch(
      "https://api.example.test",
      {},
      {
        onStart,
        onChunk,
        onEnd: vi.fn(),
        onError: vi.fn(),
      },
    );
    const streamId = postMessage.mock.calls[0][0].streamId;

    await protocol.receiveMessage({
      type: "lens.nativeApi.responseStart",
      streamId,
      status: 200,
      headers: {},
    });
    await protocol.receiveMessage({
      type: "lens.nativeApi.responseChunk",
      streamId,
      chunk: "chunk",
    });

    expect(onStart).toHaveBeenCalledWith(200, {});
    expect(onChunk).toHaveBeenCalledWith("chunk");
    expect(dispatch).not.toHaveBeenCalled();
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);

    await protocol.receiveMessage({ type: "lens.unknown.command" });
    expect(dispatch).toHaveBeenCalledWith({ type: "lens.unknown.command" });
  });
});
