import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as metaCommands from "../../native/commands/meta/index.cjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("meta command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects low-risk meta command family members", () => {
    expect(metaCommands.isMetaCommand("--version")).toBe(true);
    expect(metaCommands.isMetaCommand("profile.list")).toBe(true);
    expect(metaCommands.isMetaCommand("profiles")).toBe(true);
    expect(metaCommands.isMetaCommand("install")).toBe(true);
    expect(metaCommands.isMetaCommand("uninstall")).toBe(true);
    expect(metaCommands.isMetaCommand("config")).toBe(true);
    expect(metaCommands.isMetaCommand("publish")).toBe(false);
  });

  it("prints version output", async () => {
    const log = vi.fn();

    await metaCommands.executeMetaCommand({
      command: "--version",
      args: ["--version"],
      version: "9.9.9",
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn() },
    });

    expect(log).toHaveBeenCalledWith("lens v9.9.9");
  });

  it("prints profile.list empty-state output", async () => {
    const log = vi.fn();

    await metaCommands.executeMetaCommand({
      command: "profile.list",
      args: ["profile.list"],
      listRegisteredProfiles: () => [],
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn() },
    });

    expect(log).toHaveBeenCalledWith("No active profiles. Is Chrome running with the Lens extension?");
  });

  it("does not claim --find without a query", async () => {
    const handled = await metaCommands.executeMetaCommand({
      command: "--find",
      args: ["--find"],
      showFindResults: vi.fn(),
      consoleRef: { log: vi.fn(), error: vi.fn() },
      processRef: { exit: vi.fn() },
    });

    expect(handled).toBe(false);
  });


  it("prints config path when requested", async () => {
    const log = vi.fn();

    await metaCommands.executeMetaCommand({
      command: "config",
      args: ["config", "--path"],
      loadConfig: vi.fn(),
      getConfigPath: () => "/tmp/lens-config.json",
      consoleRef: { log, error: vi.fn() },
      processRef: { exit: vi.fn() },
    });

    expect(log).toHaveBeenCalledWith("/tmp/lens-config.json");
  });

  it("records a sanitized recent-command summary for meta commands", async () => {
    const recordCommand = vi.fn();
    const exit = vi.fn();

    metaCommands.runMetaCommand({
      command: "--version",
      args: ["--version"],
      version: "9.9.9",
      recordCommand,
      consoleRef: { log: vi.fn(), error: vi.fn() },
      processRef: { exit },
    });

    await flushMicrotasks();

    expect(recordCommand).toHaveBeenCalledWith({
      command: "--version",
      args: [],
      commandFamily: "meta",
      status: "started",
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits one when install cannot spawn the child process", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    metaCommands.runMetaCommand({
      command: "install",
      args: ["install", "hnfbepgmaoklhekckbpjnleifhahkcpl"],
      spawnSync: () => ({ status: null, error: new Error("spawn ENOENT") }),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, execPath: process.execPath },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Error: spawn ENOENT");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits one when uninstall cannot spawn the child process", async () => {
    const exit = vi.fn();
    const error = vi.fn();

    metaCommands.runMetaCommand({
      command: "uninstall",
      args: ["uninstall"],
      spawnSync: () => ({ status: null, error: new Error("spawn ENOENT") }),
      consoleRef: { log: vi.fn(), error },
      processRef: { exit, execPath: process.execPath },
    });

    await flushMicrotasks();
    expect(error).toHaveBeenCalledWith("Error: spawn ENOENT");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
