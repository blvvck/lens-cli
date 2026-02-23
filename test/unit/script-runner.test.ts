import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as scriptRunner from "../../native/commands/script-runner.cjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("script runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects script runner invocation", () => {
    expect(scriptRunner.isScriptRunnerInvocation(["open", "--script", "flow.json"])).toBe(true);
    expect(scriptRunner.isScriptRunnerInvocation(["open", "https://example.com"])).toBe(false);
  });

  it("fails when --script has no path", async () => {
    const error = vi.fn();
    const exit = vi.fn();

    await scriptRunner.executeScriptRunner({
      args: ["--script"],
      socketPath: "/tmp/lens.sock",
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, stdout: { write: vi.fn() } },
    });

    expect(error).toHaveBeenCalledWith("Error: --script requires a file path");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("dry-runs script steps without opening a socket", async () => {
    const log = vi.fn();
    const exit = vi.fn();

    await scriptRunner.executeScriptRunner({
      args: ["--script", "flow.json", "--dry-run"],
      socketPath: "/tmp/lens.sock",
      fsRef: {
        existsSync: () => true,
        readFileSync: () =>
          JSON.stringify({
            name: "demo",
            steps: [{ tool: "open", args: { url: "https://example.com" } }],
          }),
      },
      netRef: { createConnection: vi.fn() },
      consoleRef: { log, error: vi.fn() },
      processRef: { exit, stdout: { write: vi.fn() } },
    });

    expect(log).toHaveBeenCalledWith("Running: demo (1 steps)");
    expect(log).toHaveBeenCalledWith("(dry-run mode)\n");
    expect(log).toHaveBeenCalledWith('[1/1] open url="https://example.com"');
    expect(log).toHaveBeenCalledWith("Summary: 1 steps would run");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("loads and runs a real script with only console and process overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lens-script-runner-"));
    const scriptPath = join(dir, "flow.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        name: "real script",
        steps: [{ tool: "open", args: { url: "https://example.com" } }],
      }),
    );
    const log = vi.fn();
    const exit = vi.fn();

    try {
      await scriptRunner.executeScriptRunner({
        args: ["--script", scriptPath, "--dry-run"],
        socketPath: "/tmp/lens.sock",
        consoleRef: { log, error: vi.fn() },
        processRef: { exit, stdout: { write: vi.fn() } },
      });

      expect(log).toHaveBeenCalledWith("Running: real script (1 steps)");
      expect(log).toHaveBeenCalledWith('[1/1] open url="https://example.com"');
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes script requests through the socket and exits zero on success", async () => {
    const log = vi.fn();
    const write = vi.fn();
    const exit = vi.fn();
    const handlers: Record<string, (...args: any[]) => void> = {};
    const sock = {
      on: vi.fn((event: string, fn: (...args: any[]) => void) => {
        handlers[event] = fn;
        return sock;
      }),
      write: vi.fn(() => {
        handlers.data?.(Buffer.from('{"result":{"ok":true}}\n'));
        handlers.close?.();
      }),
      end: vi.fn(),
      destroy: vi.fn(),
    };

    await scriptRunner.executeScriptRunner({
      args: ["--script", "flow.json"],
      socketPath: "/tmp/lens.sock",
      fsRef: {
        existsSync: () => true,
        readFileSync: () =>
          JSON.stringify({
            steps: [{ tool: "open", args: { url: "https://example.com" } }],
          }),
      },
      netRef: {
        createConnection: vi.fn((_path: string, onConnect: (...args: any[]) => void) => {
          queueMicrotask(() => onConnect());
          return sock;
        }),
      },
      consoleRef: { log, error: vi.fn() },
      processRef: { exit, stdout: { write } },
      setTimeoutRef: vi.fn(() => 1),
      clearTimeoutRef: vi.fn(),
      dateNow: () => 1,
      randomRef: () => 2,
    });

    await flushMicrotasks();
    expect(write).toHaveBeenCalledWith('[1/1] open url="https://example.com" ... ');
    expect(log).toHaveBeenCalledWith("OK");
    expect(log).toHaveBeenCalledWith("Summary: 1 passed, 0 failed, 1 total");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
