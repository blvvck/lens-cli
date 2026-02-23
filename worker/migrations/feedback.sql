-- Migration: Feedback records table for lens-cli feedback ingest
-- Run against D1 before deploying the feedback worker

CREATE TABLE IF NOT EXISTS feedback_records (
  id TEXT PRIMARY KEY,                    -- Client-generated feedback ID (idempotency key)
  server_id TEXT UNIQUE NOT NULL,         -- Server-generated authoritative ID
  note TEXT NOT NULL,                     -- User's feedback note
  context_json TEXT,                      -- Optional context attachment (JSON)
  command_summary_json TEXT,              -- Optional recent command summary (JSON)
  client_id TEXT NOT NULL,                -- Install-scoped client ID
  client_version TEXT NOT NULL,           -- CLI version
  platform_json TEXT NOT NULL,            -- Platform info { os, arch }
  status TEXT NOT NULL DEFAULT 'received',-- Record status
  created_at INTEGER NOT NULL,            -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL             -- Unix timestamp (ms)
);

-- Index for client-based queries
CREATE INDEX IF NOT EXISTS idx_feedback_client_id ON feedback_records(client_id);

-- Index for status-based queries
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_records(status);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback_records(created_at);
