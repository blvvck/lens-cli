import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as topLevelDispatch from "../../native/commands/top-level-dispatch.cjs";

describe("top-level dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates workflow commands", () => {
    const runFlowCommand = vi.fn();
    const recordCommand = vi.fn();

    const workflowResult = topLevelDispatch.runTopLevelDispatch({
      args: ["workflow.list"],
      socketPath: "/tmp/lens.sock",
      isFlowCommand: () => true,
      runFlowCommand,
      recordCommand,
      processRef: process,
      consoleRef: console,
    });

    expect(workflowResult).toEqual({ handled: true, socketPath: "/tmp/lens.sock" });
    expect(runFlowCommand).toHaveBeenCalled();
    expect(recordCommand).toHaveBeenCalledWith({
      command: "workflow.list",
      args: [],
      commandFamily: "workflow",
      status: "started",
    });
  });
});
