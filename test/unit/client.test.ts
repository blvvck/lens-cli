import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  createClient,
  LensClientError,
  resolveSocketPath,
  sendTool,
} from "../../native/client.cjs";

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;

  write(chunk: string) {
    this.written.push(chunk);
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }

  reply(payload: unknown) {
    this.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
  }

  replyRaw(text: string) {
    this.emit("data", Buffer.from(text));
  }
}

function connectTo(socket: FakeSocket) {
  return () => {
    process.nextTick(() => socket.emit("connect"));
    return socket;
  };
}

const toolResponse = {
  type: "lens.socket.toolResponse",
  id: "1",
  result: { content: [{ type: "text", text: "ok" }] },
};

describe("lens client socket resolution", () => {
  const base = {
    readConfig: () => ({}),
    currentProfile: () => null,
    registeredProfiles: () => [],
    exists: () => false,
    env: {},
    platform: "darwin",
  };

  it("prefers an explicit profile", () => {
    const socket = resolveSocketPath({
      ...base,
      profile: "work",
      resolve: () => ({
        profile: { slug: "work", endpoint: "/tmp/lens-work.sock" },
        matches: [],
        exact: true,
      }),
    });
    expect(socket).toBe("/tmp/lens-work.sock");
  });

  it("prefers LENS_SOCKET over profile discovery", () => {
    const socket = resolveSocketPath({ ...base, env: { LENS_SOCKET: "/tmp/custom.sock" } });
    expect(socket).toBe("/tmp/custom.sock");
  });

  it("follows the configured default profile", () => {
    const socket = resolveSocketPath({
      ...base,
      readConfig: () => ({ defaultProfile: "design" }),
      resolve: () => ({
        profile: { slug: "design", endpoint: "/tmp/lens-design.sock" },
        matches: [],
        exact: true,
      }),
    });
    expect(socket).toBe("/tmp/lens-design.sock");
  });

  it("falls back to the current profile, then a single profile, then the default endpoint", () => {
    expect(
      resolveSocketPath({
        ...base,
        currentProfile: () => ({ endpoint: "/tmp/lens-current.sock" }),
      }),
    ).toBe("/tmp/lens-current.sock");

    expect(
      resolveSocketPath({
        ...base,
        registeredProfiles: () => [{ endpoint: "/tmp/lens-only.sock" }],
      }),
    ).toBe("/tmp/lens-only.sock");

    expect(resolveSocketPath(base)).toMatch(/lens\.sock$/);
  });

  it("rejects an ambiguous profile with the matches attached", () => {
    expect(() =>
      resolveSocketPath({
        ...base,
        profile: "work",
        resolve: () => ({
          profile: null,
          matches: [{ slug: "work-a" }, { slug: "work-b" }],
          exact: false,
        }),
      }),
    ).toThrowError(/Ambiguous profile "work"/);

    try {
      resolveSocketPath({
        ...base,
        profile: "work",
        resolve: () => ({
          profile: null,
          matches: [{ slug: "work-a" }, { slug: "work-b" }],
          exact: false,
        }),
      });
    } catch (error) {
      const clientError = error as { code?: string; matches?: unknown[] };
      expect(error).toBeInstanceOf(LensClientError);
      expect(clientError.code).toBe("AMBIGUOUS_PROFILE");
      expect(clientError.matches).toHaveLength(2);
    }
  });

  it("rejects a missing profile when no socket exists", () => {
    try {
      resolveSocketPath({
        ...base,
        profile: "gone",
        resolve: () => ({ profile: null, matches: [], exact: false }),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PROFILE_NOT_FOUND");
    }
  });

  it("accepts a profile socket that exists on disk", () => {
    const socket = resolveSocketPath({
      ...base,
      profile: "gone",
      resolve: () => ({ profile: null, matches: [], exact: false }),
      exists: () => true,
    });
    expect(socket).toMatch(/lens-gone\.sock$/);
  });
});

describe("lens client transport", () => {
  it("sends the tool request envelope and resolves the raw response", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.state",
      { depth: 2 },
      { socketPath: "/tmp/x.sock", connect: connectTo(socket) },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.reply(toolResponse);

    await expect(pending).resolves.toEqual(toolResponse);
    expect(JSON.parse(socket.written[0])).toMatchObject({
      type: "lens.socket.toolRequest",
      method: "execute_tool",
      params: { tool: "page.state", args: { depth: 2 } },
    });
  });

  it("forwards tab and window ids and omits them when unset", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.inspect",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket), tabId: 4, windowId: 7 },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.reply(toolResponse);
    await pending;

    const request = JSON.parse(socket.written[0]);
    expect(request.tabId).toBe(4);
    expect(request.windowId).toBe(7);

    const second = new FakeSocket();
    const secondPending = sendTool(
      "page.inspect",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(second) },
    );
    await vi.waitFor(() => expect(second.written).toHaveLength(1));
    second.reply(toolResponse);
    await secondPending;

    const secondRequest = JSON.parse(second.written[0]);
    expect(secondRequest).not.toHaveProperty("tabId");
    expect(secondRequest).not.toHaveProperty("windowId");
  });

  it("rejects a host tool error with the message and response attached", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "click",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket) },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.reply({
      type: "lens.socket.toolResponse",
      id: "1",
      error: { content: [{ type: "text", text: "No such element" }] },
    });

    await expect(pending).rejects.toMatchObject({
      code: "TOOL_ERROR",
      message: "No such element",
    });
  });

  it("returns the raw error response when rejection is disabled", async () => {
    const socket = new FakeSocket();
    const errorResponse = {
      type: "lens.socket.toolResponse",
      id: "1",
      error: { content: [{ type: "text", text: "nope" }] },
    };
    const pending = sendTool(
      "click",
      {},
      {
        socketPath: "/tmp/x.sock",
        connect: connectTo(socket),
        rejectOnToolError: false,
      },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.reply(errorResponse);

    await expect(pending).resolves.toEqual(errorResponse);
  });

  it("rejects when the extension disconnects", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.state",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket) },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.reply({ type: "lens.socket.extensionDisconnected", message: "Extension went away" });

    await expect(pending).rejects.toMatchObject({
      code: "EXTENSION_DISCONNECTED",
      message: "Extension went away",
    });
  });

  it("reports a missing host as a connection problem", async () => {
    const pending = sendTool(
      "page.state",
      {},
      {
        socketPath: "/tmp/missing.sock",
        connect: () => {
          const socket = new FakeSocket();
          process.nextTick(() => {
            const error: NodeJS.ErrnoException = new Error("connect ENOENT");
            error.code = "ENOENT";
            socket.emit("error", error);
          });
          return socket;
        },
      },
    );

    await expect(pending).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("rejects malformed responses", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.state",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket) },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.replyRaw("{not json}\n");

    await expect(pending).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects when the host closes before answering", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.state",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket) },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));
    socket.emit("close");

    await expect(pending).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
  });

  it("times out and destroys the socket", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.state",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket), timeout: 20 },
    );

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(socket.destroyed).toBe(true);
  });

  it("ignores stream events and reassembles split lines", async () => {
    const socket = new FakeSocket();
    const pending = sendTool(
      "page.state",
      {},
      { socketPath: "/tmp/x.sock", connect: connectTo(socket) },
    );
    await vi.waitFor(() => expect(socket.written).toHaveLength(1));

    socket.replyRaw(`${JSON.stringify({ type: "stream_started", streamId: 3 })}\n`);
    const body = JSON.stringify(toolResponse);
    socket.replyRaw(body.slice(0, 12));
    socket.replyRaw(`${body.slice(12)}\n`);

    await expect(pending).resolves.toEqual(toolResponse);
  });

  it("createClient binds the socket path", async () => {
    const client = createClient({ socketPath: "/tmp/bound.sock" });
    expect(client.socketPath).toBe("/tmp/bound.sock");
  });
});
