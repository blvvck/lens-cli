import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as headlessCommands from "../../native/commands/headless/index.cjs";

class FakeSocket extends EventEmitter {
  writes: string[] = [];
  ended = false;

  write(chunk: string) {
    this.writes.push(chunk);
  }

  end() {
    this.ended = true;
  }
}

describe("headless command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes prefixed headless commands onto the headless socket", () => {
    expect(
      headlessCommands.routeHeadlessInvocation({
        args: ["headless", "open", "https://example.com"],
        headlessSocket: "/tmp/lens-headless.sock",
      }),
    ).toEqual({
      args: ["open", "https://example.com"],
      isHeadlessMode: true,
      socketPath: "/tmp/lens-headless.sock",
    });
  });

  it("detects lifecycle commands only", () => {
    expect(headlessCommands.isHeadlessLifecycleCommand("headless.start")).toBe(true);
    expect(headlessCommands.isHeadlessLifecycleCommand("headless.stop")).toBe(true);
    expect(headlessCommands.isHeadlessLifecycleCommand("headless.status")).toBe(true);
    expect(headlessCommands.isHeadlessLifecycleCommand("headless")).toBe(false);
    expect(headlessCommands.isHeadlessLifecycleCommand("open")).toBe(false);
  });

  it("prints already-running output for headless.start when the pid is alive", () => {
    const log = vi.fn();
    const exit = vi.fn();
    const kill = vi.fn();
    const recordCommand = vi.fn();

    const handled = headlessCommands.runHeadlessCommand({
      command: "headless.start",
      args: ["headless.start"],
      headlessSocket: "/tmp/lens-headless.sock",
      headlessPidFile: "/tmp/lens-headless.pid",
      headlessLogFile: "/tmp/lens-headless.log",
      daemonPath: "/tmp/headless-daemon.cjs",
      fsRef: {
        readFileSync: () => "4321\n",
      },
      processRef: { kill, exit, execPath: process.execPath },
      consoleRef: { log, error: vi.fn() },
      recordCommand,
      spawnProc: vi.fn(),
      setTimeoutRef: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(kill).toHaveBeenCalledWith(4321, 0);
    expect(log).toHaveBeenCalledWith("Headless daemon already running (PID 4321)");
    expect(recordCommand).toHaveBeenCalledWith({
      command: "headless.start",
      args: [],
      commandFamily: "headless",
      status: "started",
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("prints status details from the daemon socket", () => {
    const log = vi.fn();
    const exit = vi.fn();
    const socket = new FakeSocket();

    const handled = headlessCommands.runHeadlessCommand({
      command: "headless.status",
      args: ["headless.status"],
      headlessSocket: "/tmp/lens-headless.sock",
      headlessPidFile: "/tmp/lens-headless.pid",
      headlessLogFile: "/tmp/lens-headless.log",
      daemonPath: "/tmp/headless-daemon.cjs",
      fsRef: {
        readFileSync: () => "4321\n",
        unlinkSync: vi.fn(),
      },
      processRef: { kill: vi.fn(), exit },
      consoleRef: { log, error: vi.fn() },
      netRef: {
        createConnection: (_path: string, onConnect: () => void) => {
          queueMicrotask(onConnect);
          return socket;
        },
      },
      setTimeoutRef: vi.fn(),
    });

    expect(handled).toBe(true);

    socket.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          pid: 4321,
          mode: "local",
          url: "https://example.com",
          viewport: { width: 1280, height: 720 },
        }) + "\n",
      ),
    );

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "Headless daemon running (PID 4321)",
      "Mode: local",
      "URL: https://example.com",
      "Viewport: 1280x720",
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
