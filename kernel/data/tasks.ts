// Tasks: one row per env.AI call from any app. What was asked, what came back and which tools ran are not
// here — they are the task's thread in messages (thread_id). This row is the index: who, what for, status, tokens, timing.
import { randomUUID } from "crypto";
import { all, run, one } from "./db.js";
import { listMessages, type MessageRow } from "./messages.js";

export type TaskKind = "ask" | "run" | "stream";
export type Task = {
  id: number; thread_id: string; app_id: string; kind: TaskKind; summary: string; status: "running" | "done" | "error";
  error: string; input_tokens: number; output_tokens: number; started_at: string; finished_at: string | null; duration_ms: number;
};
/** A list row also carries the first user message and the number of tool calls, read from the thread. */
export type TaskSummary = Task & { prompt: string; tool_count: number };

export const startTask = (appId: string, kind: TaskKind, summary: string): { id: number; threadId: string } => {
  const threadId = randomUUID();
  const r = run("INSERT INTO tasks (thread_id, app_id, kind, summary) VALUES (?, ?, ?, ?)", threadId, appId, kind, summary.slice(0, 200));
  return { id: Number(r.lastInsertRowid), threadId };
};

export const finishTask = (id: number, status: "done" | "error", detail: { error?: string; usage?: any } = {}) => {
  const usage = detail.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  run(`UPDATE tasks SET status = ?, error = ?, input_tokens = ?, output_tokens = ?,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
       WHERE id = ?`,
    status, String(detail.error || "").slice(0, 4000), inputTokens, outputTokens, id);
};

export const listTasks = (limit = 100): TaskSummary[] =>
  all<TaskSummary>(`SELECT t.*,
      COALESCE((SELECT substr(json_extract(m.item_json, '$.content[0].text'), 1, 240) FROM messages m
                 WHERE m.thread_id = t.thread_id AND json_extract(m.item_json, '$.role') = 'user' ORDER BY m.seq LIMIT 1), '') AS prompt,
      (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.thread_id AND json_extract(m.item_json, '$.type') = 'function_call') AS tool_count
    FROM tasks t ORDER BY t.id DESC LIMIT ?`, Math.min(500, limit));

export const getTask = (id: number): { task: Task; messages: MessageRow[] } | null => {
  const task = one<Task>("SELECT * FROM tasks WHERE id = ?", id);
  return task ? { task, messages: listMessages(task.thread_id) } : null;
};

export const runningCount = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'")?.n ?? 0;
