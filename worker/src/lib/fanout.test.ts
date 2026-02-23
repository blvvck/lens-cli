import { describe, expect, it, vi } from 'vitest';
import {
  createFeedbackFanoutPayload,
  postFeedbackFanout,
} from './fanout';

describe('feedback fan-out', () => {
  it('builds the minimal webhook payload from feedback data', () => {
    const payload = createFeedbackFanoutPayload({
      serverFeedbackId: 'srv_test_123',
      clientFeedbackId: 'fb_test_123',
      receivedAt: 1712044800000,
      note: 'dropdown took 6 clicks and JS fallback before it finally worked',
      context: {
        command: 'click',
        commandFamily: 'browser',
      },
      clientVersion: '2.6.0',
      platform: {
        os: 'darwin',
        arch: 'arm64',
      },
    });

    expect(payload).toEqual({
      source: 'lens-feedback-worker',
      authoritativeFeedbackId: 'srv_test_123',
      clientFeedbackId: 'fb_test_123',
      receivedAt: '2024-04-02T08:00:00.000Z',
      noteExcerpt: 'dropdown took 6 clicks and JS fallback before it finally worked',
      command: 'click',
      commandFamily: 'browser',
      clientVersion: '2.6.0',
      platform: {
        os: 'darwin',
        arch: 'arm64',
      },
    });
  });

  it('skips fan-out cleanly when no webhook is configured', async () => {
    const result = await postFeedbackFanout(
      {},
      {
        serverFeedbackId: 'srv_test_123',
        clientFeedbackId: 'fb_test_123',
        receivedAt: 1712044800000,
        note: 'Need a more descriptive error',
        clientVersion: '2.6.0',
        platform: {
          os: 'darwin',
          arch: 'arm64',
        },
      },
      vi.fn(),
    );

    expect(result).toEqual({
      attempted: false,
      delivered: false,
      statusCode: null,
      error: null,
      skippedReason: 'FEEDBACK_FANOUT_WEBHOOK_URL is not configured',
    });
  });

  it('posts the webhook payload and reports success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 202 }),
    );

    const result = await postFeedbackFanout(
      {
        FEEDBACK_FANOUT_WEBHOOK_URL: 'https://feedback.example.test/hook',
      },
      {
        serverFeedbackId: 'srv_test_123',
        clientFeedbackId: 'fb_test_123',
        receivedAt: 1712044800000,
        note: 'Need a more descriptive error',
        context: {
          command: 'mail.whoami',
          commandFamily: 'mail',
        },
        clientVersion: '2.6.0',
        platform: {
          os: 'darwin',
          arch: 'arm64',
        },
      },
      fetchMock,
    );

    expect(result).toEqual({
      attempted: true,
      delivered: true,
      statusCode: 202,
      error: null,
      skippedReason: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://feedback.example.test/hook');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      authoritativeFeedbackId: 'srv_test_123',
      clientFeedbackId: 'fb_test_123',
      command: 'mail.whoami',
      commandFamily: 'mail',
    });
  });

  it('keeps failures non-throwing so ingest can stay authoritative', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    const result = await postFeedbackFanout(
      {
        FEEDBACK_FANOUT_WEBHOOK_URL: 'https://feedback.example.test/hook',
      },
      {
        serverFeedbackId: 'srv_test_123',
        clientFeedbackId: 'fb_test_123',
        receivedAt: 1712044800000,
        note: 'Need a more descriptive error',
        clientVersion: '2.6.0',
        platform: {
          os: 'darwin',
          arch: 'arm64',
        },
      },
      fetchMock,
    );

    expect(result).toEqual({
      attempted: true,
      delivered: false,
      statusCode: 500,
      error: 'Fan-out returned HTTP 500',
      skippedReason: null,
    });
  });
});
