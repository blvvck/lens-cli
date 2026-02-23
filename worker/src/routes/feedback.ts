import type { Context } from 'hono';
import { z } from 'zod';
import { generateId } from '../lib/id';
import { postFeedbackFanout } from '../lib/fanout';

// Request schema validation
const feedbackRequestSchema = z.object({
  id: z.string().min(1).regex(/^fb_[a-zA-Z0-9_-]+$/),
  note: z.string().min(1).max(10000),
  context: z.record(z.unknown()).optional(),
  commandSummary: z.record(z.unknown()).optional(),
  clientId: z.string().min(1).regex(/^lens_[a-zA-Z0-9_-]+$/),
  clientVersion: z.string().regex(/^\d+\.\d+\.\d+/),
  platform: z.object({
    os: z.string().min(1),
    arch: z.string().min(1),
  }),
});

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

/** POST /api/v1/feedback/ingest — Ingest feedback from CLI */
export async function handleFeedbackIngest(c: Context): Promise<Response> {
  const db = c.env.DB as D1Database;

  // Parse and validate request body
  let body: FeedbackRequest;
  try {
    const raw = await c.req.text();
    if (raw.length > 32 * 1024) {
      return c.json({ ok: false, error: 'Payload too large', code: 413 }, 413);
    }
    body = feedbackRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    const issues = err instanceof z.ZodError
      ? (err.issues ?? (err as { errors?: z.ZodIssue[] }).errors ?? [])
      : null;
    const message = issues
      ? issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
      : 'Invalid JSON payload';
    return c.json(
      { ok: false, error: `Validation error: ${message}`, code: 400 },
      400
    );
  }

  const now = Date.now();

  try {
    // Check for existing record by client idempotency key
    const existing = await db.prepare(
      `SELECT server_id, status, created_at
       FROM feedback_records
       WHERE id = ?`
    ).bind(body.id).first<{
      server_id: string;
      status: string;
      created_at: number;
    }>();

    if (existing) {
      // Idempotent return of existing record
      return c.json({
        ok: true,
        data: {
          serverFeedbackId: existing.server_id,
          status: existing.status,
          receivedAt: existing.created_at,
        },
      });
    }

    // Generate server-side authoritative ID
    const serverId = generateId('srv');

    // Insert new feedback record
    await db.prepare(
      `INSERT INTO feedback_records (
        id, server_id, note, context_json, command_summary_json,
        client_id, client_version, platform_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.id,
      serverId,
      body.note,
      body.context ? JSON.stringify(body.context) : null,
      body.commandSummary ? JSON.stringify(body.commandSummary) : null,
      body.clientId,
      body.clientVersion,
      JSON.stringify(body.platform),
      'received',
      now,
      now
    ).run();

    const fanoutTask = postFeedbackFanout(c.env, {
      serverFeedbackId: serverId,
      clientFeedbackId: body.id,
      receivedAt: now,
      note: body.note,
      context: body.context,
      commandSummary: body.commandSummary,
      clientVersion: body.clientVersion,
      platform: body.platform,
    })
      .then((result) => {
        if (!result.attempted || result.delivered) {
          return;
        }
        console.error('[feedback-fanout] Delivery failed:', result.error);
      })
      .catch((fanoutErr) => {
        console.error('[feedback-fanout] Unexpected error:', fanoutErr);
      });
    c.executionCtx?.waitUntil(fanoutTask);

    // Return success with server-generated IDs
    return c.json({
      ok: true,
      data: {
        serverFeedbackId: serverId,
        status: 'received',
        receivedAt: now,
      },
    }, 201);

  } catch (err) {
    console.error('Feedback ingest error:', err);
    return c.json(
      { ok: false, error: 'Internal server error', code: 500 },
      500
    );
  }
}
