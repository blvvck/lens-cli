import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as flowCommands from "../../native/commands/flow/index.cjs";

describe("flow command module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects the flow command family", () => {
    expect(flowCommands.isFlowCommand("flow")).toBe(true);
    expect(flowCommands.isFlowCommand("flow.list")).toBe(true);
    expect(flowCommands.isFlowCommand("flow.info")).toBe(true);
    expect(flowCommands.isFlowCommand("publish")).toBe(false);
  });

  it("parses flow flags into workflow execution options and vars", () => {
    expect(
      flowCommands.parseFlowFlags([
        "login-flow",
        "--email",
        "me@example.com",
        "--count",
        "3",
        "--enabled",
        "true",
        "--dry-run",
        "--tab-id",
        "12",
      ]),
    ).toEqual({
      commandsInput: "login-flow",
      fileInput: null,
      actionsInput: null,
      dryRun: true,
      onError: "stop",
      noAutoWait: false,
      stepDelay: 100,
      wantJson: false,
      tabId: 12,
      windowId: undefined,
      workflowArgs: {
        email: "me@example.com",
        count: 3,
        enabled: true,
      },
    });
  });

  it("parses the canonical file option", () => {
    expect(flowCommands.parseFlowFlags(["--file", "flow.json"]).fileInput).toBe("flow.json");
  });

  it("lists workflows from project and user directories", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lens-workflow-project-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lens-workflow-home-"));
    const projectDir = path.join(cwd, ".lens", "flows");
    const userDir = path.join(home, ".lens", "flows");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "build.json"),
      JSON.stringify({
        name: "build",
        description: "Build the project",
        steps: [{ tool: "open", args: { url: "https://example.com" } }],
      }),
    );
    fs.writeFileSync(
      path.join(userDir, "login.json"),
      JSON.stringify({
        name: "login",
        description: "Login flow",
        args: { email: { required: true } },
        steps: [{ cmd: "open", args: { url: "https://example.com" } }],
      }),
    );

    const workflows = flowCommands.listFlows({
      cwd: () => cwd,
      os: { homedir: () => home },
    });

    expect(workflows).toEqual([
      expect.objectContaining({ name: "build", scope: "project", stepCount: 1 }),
      expect.objectContaining({ name: "login", scope: "user", stepCount: 1 }),
    ]);
  });

  it("preserves workflow.info usage failure when name is missing", async () => {
    const error = vi.fn();

    await expect(
      flowCommands.executeFlowCommand({
        command: "flow.info",
        args: [],
        consoleRef: { log: vi.fn(), error },
        processRef: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(error).toHaveBeenCalledWith("Error: workflow name required");
  });

  it("formats workflow.info output from a named workflow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lens-workflow-info-project-"));
    const projectDir = path.join(cwd, ".lens", "flows");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "login.json"),
      JSON.stringify({
        name: "login",
        description: "Login flow",
        args: {
          email: { required: true, description: "Email address" },
        },
        steps: [
          { tool: "open", args: { url: "https://example.com/login" } },
          { tool: "type", args: { ref: "e1", text: "${email}" } },
        ],
      }),
    );

    const log = vi.fn();

    await flowCommands.executeFlowCommand({
      command: "flow.info",
      args: ["login"],
      consoleRef: { log, error: vi.fn() },
      processRef: { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
      cwd: () => cwd,
    });

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "login - Login flow",
      "",
      "Arguments:",
      "  --email (required)",
      "      Email address",
      "",
      "Steps (2):",
      '  1. open url="https://example.com/login"',
      '  2. type ref="e1" text="${email}"',
      "",
      `Location: ${path.join(projectDir, "login.json")}`,
      "",
      "Run:",
      '  lens flow login --email "..."',
    ]);
  });
});
