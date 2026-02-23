import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function makeTempHome() {
  return mkdtempSync(join(tmpdir(), "lens-feedback-test-"));
}

function runFeedbackCommand({
  args,
  input,
  homeDir,
  env,
}: {
  args: string[];
  input?: string;
  homeDir: string;
  env?: Record<string, string>;
}) {
  return spawnSync(process.execPath, [resolve(process.cwd(), "native/cli/index.cjs"), "feedback", ...args], {
    cwd: process.cwd(),
    input,
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

function runFeedbackCommandAsync({
  args,
  input,
  homeDir,
  env,
}: {
  args: string[];
  input?: string;
  homeDir: string;
  env?: Record<string, string>;
}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [resolve(process.cwd(), "native/cli/index.cjs"), "feedback", ...args], {
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

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function getFeedbackPaths(homeDir: string) {
  return {
    baseDir: join(homeDir, ".lens", "feedback"),
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

function writeFeedbackRecord({
  homeDir,
  bucket,
  record,
}: {
  homeDir: string;
  bucket: "outbox" | "sent";
  record: Record<string, unknown>;
}) {
  const paths = getFeedbackPaths(homeDir);
  const dirPath = bucket === "outbox" ? paths.outboxDir : paths.sentDir;
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, `${record.id}.json`), JSON.stringify(record, null, 2));
}

async function withFeedbackServer<T>(
  runTest: (serverInfo: {
    baseUrl: string;
    requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }>;
  }) => Promise<T>
) {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: any }> = [];
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "healthy" }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/feedback/ingest") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({
          headers: req.headers,
          body: JSON.parse(body),
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          data: {
            serverFeedbackId: "srv_test_feedback",
            status: "received",
            receivedAt: 1712059200000,
          },
        }));
      });
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
    throw new Error("Failed to bind test feedback server");
  }

  try {
    return await runTest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests,
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

function readQueuedFeedback(homeDir: string) {
  const { outboxDir } = getFeedbackPaths(homeDir);
  const files = listJsonRecords(outboxDir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(outboxDir, files[0]), "utf8"));
}

describe("feedback command", () => {
  it("queues feedback from --stdin using the same durable record shape", () => {
    const homeDir = makeTempHome();
    try {
      const result = runFeedbackCommand({
        args: ["--stdin"],
        input: "First line\nSecond line\n",
        homeDir,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Feedback queued:");

      const record = readQueuedFeedback(homeDir);
      expect(record.status).toBe("queued");
      expect(record.note).toBe("First line\nSecond line");
      expect(record.context).toBeNull();
      expect(record.commandSummary).toBeNull();
      expect(record.deliveryAttempts).toEqual([]);
      expect(record.serverAck).toBeNull();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects empty --stdin input with a clear usage error", () => {
    const homeDir = makeTempHome();
    try {
      const result = runFeedbackCommand({
        args: ["--stdin"],
        input: "   \n\t",
        homeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: --stdin received empty input");
      expect(result.stderr).toContain("lens feedback --stdin");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("renders feedback log in human and JSON modes", () => {
    const homeDir = makeTempHome();
    try {
      const queueResult = runFeedbackCommand({
        args: ["Queued note for log output"],
        homeDir,
      });
      expect(queueResult.status).toBe(0);

      const queuedRecord = readQueuedFeedback(homeDir);
      writeFeedbackRecord({
        homeDir,
        bucket: "sent",
        record: {
          id: "fb_sent_record",
          createdAt: queuedRecord.createdAt - 1000,
          status: "sent",
          note: "Already delivered",
          context: null,
          commandSummary: null,
          clientVersion: "0.0.0-test",
          platform: "darwin arm64",
          deliveryAttempts: [{ timestamp: queuedRecord.createdAt - 500, success: true }],
          serverAck: {
            feedbackId: "srv_sent_record",
            timestamp: queuedRecord.createdAt - 500,
          },
          movedToSentAt: queuedRecord.createdAt - 500,
        },
      });

      const humanLog = runFeedbackCommand({
        args: ["log"],
        homeDir,
      });
      expect(humanLog.status).toBe(0);
      expect(humanLog.stdout).toContain("Feedback records: 2");
      expect(humanLog.stdout).toContain(queuedRecord.id);
      expect(humanLog.stdout).toContain("Status:       queued");
      expect(humanLog.stdout).toContain("fb_sent_record");
      expect(humanLog.stdout).toContain("Status:       sent");

      const jsonLog = runFeedbackCommand({
        args: ["log", "--json"],
        homeDir,
      });
      expect(jsonLog.status).toBe(0);
      const parsed = JSON.parse(jsonLog.stdout);
      expect(parsed).toHaveLength(2);
      expect(parsed.map((record: any) => record.id)).toEqual(
        expect.arrayContaining([queuedRecord.id, "fb_sent_record"])
      );
      expect(parsed.find((record: any) => record.id === queuedRecord.id)?.status).toBe("queued");
      expect(parsed.find((record: any) => record.id === "fb_sent_record")?.status).toBe("sent");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("prints the exact stored payload for feedback show", () => {
    const homeDir = makeTempHome();
    try {
      const storedRecord = {
        id: "fb_show_record",
        createdAt: 1712059200000,
        status: "ack_unknown",
        note: "Need a repro for flaky dropdown",
        context: {
          command: "click",
          commandFamily: "browser",
        },
        commandSummary: null,
        clientVersion: "0.0.0-test",
        platform: "darwin arm64",
        deliveryAttempts: [
          {
            timestamp: 1712059205000,
            success: false,
            error: "Timed out waiting for ack",
            ackUnknown: true,
          },
        ],
        serverAck: null,
        lastAttemptAt: 1712059205000,
        lastError: "Timed out waiting for ack",
      };
      writeFeedbackRecord({
        homeDir,
        bucket: "outbox",
        record: storedRecord,
      });

      const result = runFeedbackCommand({
        args: ["show", "fb_show_record", "--json"],
        homeDir,
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(storedRecord);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports feedback status and bootstraps local client credentials", () => {
    const homeDir = makeTempHome();
    try {
      const result = runFeedbackCommand({
        args: ["status", "--json"],
        homeDir,
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.stats.outboxCount).toBe(0);
      expect(parsed.stats.sentCount).toBe(0);
      expect(parsed.client.status).toBe("ready");
      expect(parsed.client.clientId).toMatch(/^lens_/);
      expect(parsed.endpoint.configured).toBe(false);
      expect(existsSync(getFeedbackPaths(homeDir).clientPath)).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("retries an ack_unknown feedback record against the configured endpoint without changing its id", async () => {
    const homeDir = makeTempHome();
    try {
      const queueResult = runFeedbackCommand({
        args: ["Needs an explicit retry path"],
        homeDir,
      });
      expect(queueResult.status).toBe(0);

      const queuedRecord = readQueuedFeedback(homeDir);
      writeFeedbackRecord({
        homeDir,
        bucket: "outbox",
        record: {
          ...queuedRecord,
          status: "ack_unknown",
          lastAttemptAt: queuedRecord.createdAt + 100,
          lastError: "Timed out waiting for worker ack",
          deliveryAttempts: [
            {
              timestamp: queuedRecord.createdAt + 100,
              success: false,
              ackUnknown: true,
              error: "Timed out waiting for worker ack",
            },
          ],
        },
      });

      await withFeedbackServer(async ({ baseUrl, requests }) => {
        const retryResult = await runFeedbackCommandAsync({
          args: ["retry", queuedRecord.id, "--json"],
          homeDir,
          env: {
            LENS_FEEDBACK_API: baseUrl,
          },
        });

        expect(retryResult.status).toBe(0);
        const parsed = JSON.parse(retryResult.stdout);
        expect(parsed.sent).toBe(1);
        expect(parsed.results).toHaveLength(1);
        expect(parsed.results[0]).toMatchObject({
          id: queuedRecord.id,
          outcome: "sent",
        });
        expect(requests).toHaveLength(1);
        expect(requests[0].body.id).toBe(queuedRecord.id);
        expect(requests[0].headers["x-client-id"]).toMatch(/^lens_/);

        const { outboxDir, sentDir } = getFeedbackPaths(homeDir);
        expect(listJsonRecords(outboxDir)).toHaveLength(0);
        const sentFiles = listJsonRecords(sentDir);
        expect(sentFiles).toEqual([`${queuedRecord.id}.json`]);

        const sentRecord = JSON.parse(readFileSync(join(sentDir, sentFiles[0]), "utf8"));
        expect(sentRecord.id).toBe(queuedRecord.id);
        expect(sentRecord.status).toBe("sent");
        expect(sentRecord.serverAck).toEqual({
          feedbackId: "srv_test_feedback",
          timestamp: 1712059200000,
        });
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
