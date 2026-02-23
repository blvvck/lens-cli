import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error CommonJS module without type definitions
import * as configModule from "../../native/config/index.cjs";

function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeLensConfig(dirPath: string, config: Record<string, unknown>) {
  writeFileSync(join(dirPath, "lens.json"), JSON.stringify(config, null, 2));
}

function runCliWithReminderConfig({
  args,
  cwd,
  homeDir,
  env,
}: {
  args: string[];
  cwd: string;
  homeDir: string;
  env?: Record<string, string>;
}) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "native/cli/index.cjs"), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      // Isolate the bridge: without this the CLI finds a real host socket and the
      // command succeeds, which is not the failure path these tests are about.
      LENS_RUNTIME_DIR: isolatedRuntimeDir(),
      LENS_FEEDBACK_API: "",
      LENS_FEEDBACK_URL: "",
      LENS_FEEDBACK_ENDPOINT: "",
      ...env,
    },
  });
}

let runtimeDir: string | undefined;
function isolatedRuntimeDir() {
  if (!runtimeDir) {
    runtimeDir = makeTempDir("lens-reminders-runtime-");
  }
  return runtimeDir;
}

describe("feedback reminder policy", () => {
  afterEach(() => {
    configModule.clearCache();
  });

  it("uses enabled reminders and a 30s slow threshold by default", () => {
    expect(
      configModule.getFeedbackReminderPolicy({
        config: {},
        env: {},
      }),
    ).toEqual({
      enabled: true,
      slowThresholdMs: 30000,
      reminderCooldownMs: 60000,
    });
  });

  it("reads reminder enabled and slow threshold from lens.json config", () => {
    expect(
      configModule.getFeedbackReminderPolicy({
        config: {
          feedback: {
            reminders: {
              enabled: false,
              slowThresholdMs: 45000,
            },
          },
        },
        env: {},
      }),
    ).toEqual({
      enabled: false,
      slowThresholdMs: 45000,
      reminderCooldownMs: 60000,
    });
  });

  it("keeps the env kill switch and env threshold override above config values", () => {
    expect(
      configModule.getFeedbackReminderPolicy({
        config: {
          feedback: {
            reminders: {
              enabled: true,
              slowThresholdMs: 45000,
            },
          },
        },
        env: {
          LENS_FEEDBACK_REMINDERS: "0",
          LENS_FEEDBACK_SLOW_THRESHOLD_MS: "15000",
        },
      }),
    ).toEqual({
      enabled: false,
      slowThresholdMs: 15000,
      reminderCooldownMs: 60000,
    });
  });

  it("suppresses reminder hints when lens.json disables them", () => {
    const projectDir = makeTempDir("lens-reminders-project-");
    const homeDir = makeTempDir("lens-reminders-home-");

    try {
      writeLensConfig(projectDir, {
        feedback: {
          reminders: {
            enabled: false,
          },
        },
      });

      const result = runCliWithReminderConfig({
        args: ["tab.list"],
        cwd: projectDir,
        homeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error:");
      expect(result.stderr).not.toContain('Send feedback: lens feedback --last "what happened"');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("still shows reminder hints when config enables them and the command hits friction", () => {
    const projectDir = makeTempDir("lens-reminders-project-");
    const homeDir = makeTempDir("lens-reminders-home-");

    try {
      writeLensConfig(projectDir, {
        feedback: {
          reminders: {
            enabled: true,
            slowThresholdMs: 45000,
          },
        },
      });

      const result = runCliWithReminderConfig({
        args: ["tab.list"],
        cwd: projectDir,
        homeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Send feedback: lens feedback --last "what happened"');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
