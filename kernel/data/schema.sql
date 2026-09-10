-- The kernel's own database: exactly five tables. Product runtime state only — no app domain data lives here.
-- App data lives in workerd's AppStore (.wandesk/store/, apps/<id>/data.db is a symlink into it); the kernel never touches it.
--
-- conversations / messages / compactions are the assistant's conversation store (kernel/conv, from the AGENT repo);
-- the column set here is that store's, verbatim. settings is one KV table for everything configurable.
-- tasks is the record of every AI call any app makes through env.AI.

-- ── Conversations ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  workdir      TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  context_json TEXT NOT NULL DEFAULT '[]',   -- snapshot of the previous turn's context: a cache for the next run
  usage_json   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Append-only, immutable Responses items (message / reasoning / function_call / function_call_output)
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  item_json       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);

-- Append-only compaction log: which range got replaced by a summary, and how many tokens it cost
CREATE TABLE IF NOT EXISTS compactions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  start_seq       INTEGER NOT NULL CHECK (start_seq > 0),
  end_seq         INTEGER NOT NULL CHECK (end_seq >= start_seq),
  summary         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('summary', 'mechanical')),
  tokens          INTEGER NOT NULL DEFAULT 0,
  at              TEXT NOT NULL,
  PRIMARY KEY (conversation_id, end_seq)
);
CREATE INDEX IF NOT EXISTS idx_compactions_conversation ON compactions(conversation_id, end_seq);

-- ── Settings: model connection, account, context limits, system prompt, shell preferences (desktop layout / wallpaper) ──
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- ── Tasks: every env.AI call from every app — what was asked, what came back, tools used, tokens and timing ──
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'ask',     -- ask | run | stream
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running', -- running | done | error
  prompt        TEXT NOT NULL DEFAULT '',
  system        TEXT NOT NULL DEFAULT '',
  result        TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  tools         TEXT NOT NULL DEFAULT '[]',      -- JSON: [{ name, args, output }] for run / stream
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks (started_at DESC);
