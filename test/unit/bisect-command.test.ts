import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as bisectCommands from "../../native/commands/bisect.cjs";

describe("bisect command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects the bisect command", () => {
    expect(bisectCommands.isBisectCommand("bisect")).toBe(true);
    expect(bisectCommands.isBisectCommand("open")).toBe(false);
  });

  it("preserves usage failure when required flags are missing", () => {
    const error = vi.fn();

    let thrown;
    try {
      bisectCommands.executeBisectCommand({
        args: ["https://example.com"],
        consoleRef: { log: vi.fn(), error },
        processRef: { exit: vi.fn() },
      });
    } catch (value) {
      thrown = value;
    }

    expect(thrown).toMatchObject({ code: 1 });

    expect(error).toHaveBeenCalledWith(
      "Usage: lens bisect <url> --good <commit> --bad <commit> [--threshold 5] [--setup 'cmd'] [--selector '.css'] [--wait 2000]",
    );
  });

  it("runs the bisect flow and uses canonical open commands", () => {
    const log = vi.fn();
    const commands: string[] = [];

    const execSyncRef = vi.fn((command: string) => {
      commands.push(command);
      if (command === "git stash --include-untracked") return "No local changes to save";
      if (command === "git checkout good123 --quiet") return "";
      if (command.startsWith("sleep ")) return "";
      if (command === 'node native/cli/index.cjs open "https://example.com"') return "";
      if (command.includes('screenshot --output')) return "";
      if (command === "git bisect start bad999 good123 --quiet") return "";
      if (command === "git rev-parse --short HEAD") return "abcdef12";
      if (command === "git log -1 --pretty=%s") return "Regression commit";
      if (command.includes('diff ') && command.includes('--threshold 0.01')) return "12.5% mismatch";
      if (command === "git bisect bad") {
        return "1234567890abcdef1234567890abcdef12345678 is the first bad commit";
      }
      if (command === "git bisect reset") return "";
      throw new Error(`Unexpected command: ${command}`);
    });

    const handled = bisectCommands.executeBisectCommand({
      args: ["https://example.com", "--good", "good123", "--bad", "bad999"],
      execSyncRef,
      fsRef: { mkdirSync: vi.fn() },
      osRef: { tmpdir: () => "/tmp" },
      pathRef: { join: (...parts: string[]) => parts.join("/") },
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn() },
      processArgv: ["node", "native/cli/index.cjs"],
    });

    expect(handled).toBe(true);
    expect(commands).toContain('node native/cli/index.cjs open "https://example.com"');
    expect(commands.some((command) => command.includes("navigate"))).toBe(false);
    expect(log.mock.calls.map(([line]) => line)).toContain("\n\x1b[31mFirst bad commit: 12345678\x1b[0m — Regression commit");
  });
});
