import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), "lens-feedback-trust-test-"));
}

function runLensCommand({
  args,
  homeDir,
  env,
}: {
  args: string[];
  homeDir: string;
  env?: Record<string, string>;
}) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "native/cli/index.cjs"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      LENS_FEEDBACK_API: "",
      LENS_FEEDBACK_URL: "",
      LENS_FEEDBACK_ENDPOINT: "",
      LENS_FEEDBACK_TIMEOUT_MS: "1000",
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...env,
    },
  });
}

function runLensCommandAsync({
  args,
  homeDir,
  env,
}: {
  args: string[];
  homeDir: string;
  env?: Record<string, string>;
}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [resolve(process.cwd(), "native/cli/index.cjs"), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LENS_FEEDBACK_API: "",
        LENS_FEEDBACK_URL: "",
        LENS_FEEDBACK_ENDPOINT: "",
        LENS_FEEDBACK_TIMEOUT_MS: "1000",
        HOME: homeDir,
        USERPROFILE: homeDir,
        ...env,
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function getFeedbackPaths(homeDir: string) {
  return {
    feedbackDir: join(homeDir, ".lens", "feedback"),
    recentPath: join(homeDir, ".lens", "feedback", "recent.jsonl"),
    outboxDir: join(homeDir, ".lens", "feedback", "outbox"),
    sentDir: join(homeDir, ".lens", "feedback", "sent"),
    clientPath: join(homeDir, ".lens", "feedback", "client.json"),
  };
}

function listJsonRecords(dirPath: string) {
  if (!existsSync(dirPath)) {
    return [];
  }
  return readdirSync(dirPath).filter((file) => file.endsWith(".json"));
}

async function withRejectingFeedbackServer<T>(
  runTest: (serverInfo: { baseUrl: string }) => Promise<T>,
) {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/feedback/ingest") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid client credentials", code: 403 }));
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "healthy" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind rejecting feedback server");
  }

  try {
    return await runTest({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((err) => {
        if (err) {
          rejectPromise(err);
          return;
        }
        resolvePromise();
      });
    });
  }
}

describe("feedback trust contract", () => {
  it("does not auto-send on normal command execution but seeds --last context for meta commands", () => {
    const homeDir = makeTempHome();
    try {
      const versionResult = runLensCommand({
        args: ["--version"],
        homeDir,
      });

      expect(versionResult.status).toBe(0);
      expect(versionResult.stdout).toContain("lens v");

      const { outboxDir, sentDir, recentPath, clientPath } = getFeedbackPaths(homeDir);
      expect(listJsonRecords(outboxDir)).toHaveLength(0);
      expect(listJsonRecords(sentDir)).toHaveLength(0);
      expect(existsSync(clientPath)).toBe(false);
      expect(existsSync(recentPath)).toBe(true);

      const feedbackResult = runLensCommand({
        args: ["feedback", "--last", "--yes", "meta command context"],
        homeDir,
      });

      expect(feedbackResult.status).toBe(0);
      expect(feedbackResult.stdout).toContain("Feedback queued:");

      const outboxFiles = listJsonRecords(outboxDir);
      expect(outboxFiles).toHaveLength(1);
      const queuedRecord = JSON.parse(readFileSync(join(outboxDir, outboxFiles[0]), "utf8"));
      expect(queuedRecord.note).toBe("meta command context");
      expect(queuedRecord.context).toMatchObject({
        command: "--version",
        commandFamily: "meta",
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps feedback in the outbox when the server rejects client credentials", async () => {
    const homeDir = makeTempHome();
    try {
      const { clientPath, outboxDir, sentDir } = getFeedbackPaths(homeDir);
      mkdirSync(join(homeDir, ".lens", "feedback"), { recursive: true });
      writeFileSync(clientPath, JSON.stringify({
        clientId: "lens_invalid_client",
        clientSecret: "invalid-secret",
        createdAt: 1712059200000,
        version: 1,
      }, null, 2));

      await withRejectingFeedbackServer(async ({ baseUrl }) => {
        const result = await runLensCommandAsync({
          args: ["feedback", "auth rejection path"],
          homeDir,
          env: {
            LENS_FEEDBACK_API: baseUrl,
          },
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Feedback queued:");
        expect(result.stdout).toContain("Invalid client credentials");

        const outboxFiles = listJsonRecords(outboxDir);
        expect(outboxFiles).toHaveLength(1);
        expect(listJsonRecords(sentDir)).toHaveLength(0);

        const queuedRecord = JSON.parse(readFileSync(join(outboxDir, outboxFiles[0]), "utf8"));
        expect(queuedRecord.status).toBe("failed");
        expect(queuedRecord.lastError).toBe("Invalid client credentials");
        expect(queuedRecord.deliveryAttempts).toHaveLength(1);
        expect(queuedRecord.serverAck).toBeNull();
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
