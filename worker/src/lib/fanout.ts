export type FeedbackFanoutEnv = {
  FEEDBACK_FANOUT_WEBHOOK_URL?: string;
  FEEDBACK_FANOUT_TIMEOUT_MS?: string;
};

export type FeedbackFanoutInput = {
  serverFeedbackId: string;
  clientFeedbackId: string;
  receivedAt: number;
  note: string;
  context?: Record<string, unknown>;
  commandSummary?: Record<string, unknown>;
  clientVersion: string;
  platform: {
    os: string;
    arch: string;
  };
};

export type FeedbackFanoutPayload = {
  source: 'lens-feedback-worker';
  authoritativeFeedbackId: string;
  clientFeedbackId: string;
  receivedAt: string;
  noteExcerpt: string;
  command: string | null;
  commandFamily: string | null;
  clientVersion: string;
  platform: {
    os: string;
    arch: string;
  };
};

export type FeedbackFanoutResult = {
  attempted: boolean;
  delivered: boolean;
  statusCode: number | null;
  error: string | null;
  skippedReason: string | null;
};

const DEFAULT_FANOUT_TIMEOUT_MS = 3000;
const NOTE_EXCERPT_MAX = 280;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function buildNoteExcerpt(note: string): string {
  const flattened = note.replace(/\s+/g, ' ').trim();
  if (flattened.length <= NOTE_EXCERPT_MAX) {
    return flattened;
  }
  return `${flattened.slice(0, NOTE_EXCERPT_MAX - 3)}...`;
}

function resolveCommandFields(
  context?: Record<string, unknown>,
  commandSummary?: Record<string, unknown>,
): { command: string | null; commandFamily: string | null } {
  const safeContext = asRecord(context);
  const safeSummary = asRecord(commandSummary);
  return {
    command: asString(safeContext?.command) || asString(safeSummary?.command),
    commandFamily:
      asString(safeContext?.commandFamily) || asString(safeSummary?.commandFamily),
  };
}

function resolveTimeoutMs(env: FeedbackFanoutEnv): number {
  const parsed = Number.parseInt(env.FEEDBACK_FANOUT_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FANOUT_TIMEOUT_MS;
}

export function createFeedbackFanoutPayload(
  input: FeedbackFanoutInput,
): FeedbackFanoutPayload {
  const { command, commandFamily } = resolveCommandFields(input.context, input.commandSummary);
  return {
    source: 'lens-feedback-worker',
    authoritativeFeedbackId: input.serverFeedbackId,
    clientFeedbackId: input.clientFeedbackId,
    receivedAt: new Date(input.receivedAt).toISOString(),
    noteExcerpt: buildNoteExcerpt(input.note),
    command,
    commandFamily,
    clientVersion: input.clientVersion,
    platform: input.platform,
  };
}

export async function postFeedbackFanout(
  env: FeedbackFanoutEnv,
  input: FeedbackFanoutInput,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedbackFanoutResult> {
  const webhookUrl = env.FEEDBACK_FANOUT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return {
      attempted: false,
      delivered: false,
      statusCode: null,
      error: null,
      skippedReason: 'FEEDBACK_FANOUT_WEBHOOK_URL is not configured',
    };
  }

  const controller = new AbortController();
  const timeoutMs = resolveTimeoutMs(env);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(createFeedbackFanoutPayload(input)),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        attempted: true,
        delivered: false,
        statusCode: response.status,
        error: `Fan-out returned HTTP ${response.status}`,
        skippedReason: null,
      };
    }

    return {
      attempted: true,
      delivered: true,
      statusCode: response.status,
      error: null,
      skippedReason: null,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Fan-out timed out after ${timeoutMs}ms`
          : err.message
        : 'Unknown fan-out failure';
    return {
      attempted: true,
      delivered: false,
      statusCode: null,
      error: message,
      skippedReason: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
