import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as cdpCommands from "../../native/commands/cdp/index.cjs";

describe("cdp command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a sanitized recent-command summary for cdp lifecycle commands", () => {
    const log = vi.fn();
    const exit = vi.fn();
    const kill = vi.fn();
    const recordCommand = vi.fn();

    const handled = cdpCommands.runCdpCommand({
      command: "cdp.status",
      args: ["cdp.status"],
      cdpSocket: "/tmp/lens-cdp.sock",
      cdpPidFile: "/tmp/lens-cdp.pid",
      cdpLogFile: "/tmp/lens-cdp.log",
      daemonPath: "/tmp/cdp-daemon.cjs",
      fsRef: {
        readFileSync: () => "4321\n",
        unlinkSync: vi.fn(),
      },
      processRef: { kill, exit },
      consoleRef: { log, error: vi.fn() },
      netRef: {
        createConnection: () => ({
          write: vi.fn(),
          on: vi.fn(),
          end: vi.fn(),
        }),
      },
      setTimeoutRef: vi.fn(),
      recordCommand,
    });

    expect(handled).toBe(true);
    expect(kill).toHaveBeenCalledWith(4321, 0);
    expect(recordCommand).toHaveBeenCalledWith({
      command: "cdp.status",
      args: [],
      commandFamily: "headless",
      status: "started",
    });
  });
});
