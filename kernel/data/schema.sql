-- The kernel's own database: exactly five tables. Product runtime state only — no app domain data lives here.
-- App data lives in workerd's AppStore (.wandesk/store/, apps/<id>/data.db is a symlink into it); the kernel never touches it.
--
-- A thread is one run of the agent runner: a conversation (thread_id = the conversation id) or a task
-- (thread_id = tasks.thread_id). messages and compactions are shared by both and keyed by thread_id.
-- settings is one KV table for everything configurable. tasks is one row per AI call any app makes through env.AI.

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

-- ── Messages: every item the runner produces, for every thread. Append-only, immutable Responses items
--    (message / reasoning / function_call / function_call_output); a task thread also opens with the system prompt as a system message.
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  item_json  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(thread_id, seq);

-- ── Compactions: which range of a thread got replaced by a summary, and how many tokens it cost. Append-only.
CREATE TABLE IF NOT EXISTS compactions (
  thread_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL CHECK (start_seq > 0),
  end_seq   INTEGER NOT NULL CHECK (end_seq >= start_seq),
  summary   TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('summary', 'mechanical')),
  tokens    INTEGER NOT NULL DEFAULT 0,
  at        TEXT NOT NULL,
  PRIMARY KEY (thread_id, end_seq)
);
CREATE INDEX IF NOT EXISTS idx_compactions_thread ON compactions(thread_id, end_seq);

-- ── Settings: model connection, account, context limits, system prompt, shell preferences (desktop layout / wallpaper) ──
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- ── Tasks: one row per env.AI call from any app; what was said and done lives in messages under thread_id ──
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT NOT NULL UNIQUE,
  app_id        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'ask',     -- ask | run | stream
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running', -- running | done | error
  error         TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks (started_at DESC);
