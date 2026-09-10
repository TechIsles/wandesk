// Tasks: any app calling env.AI must include a summary; the kernel records the whole call here —
// what was asked, what came back, which tools ran, tokens and timing — so the user can see who is burning tokens and on what.
import { all, run, one } from "./db.js";

export type TaskKind = "ask" | "run" | "stream";
export type TaskTool = { name: string; args: string; output: string };
export type Task = {
  id: number; app_id: string; kind: TaskKind; summary: string; status: "running" | "done" | "error";
  prompt: string; system: string; result: string; error: string; tools: string;
  input_tokens: number; output_tokens: number; started_at: string; finished_at: string | null; duration_ms: number;
};
/** List rows carry only the head of the long fields; the full row comes from getTask. */
export type TaskSummary = Omit<Task, "prompt" | "system" | "result" | "tools"> & { prompt: string; result: string; tool_count: number };

const PROMPT_MAX = 60_000;
const RESULT_MAX = 60_000;
const TOOLS_MAX = 120_000;

export const startTask = (appId: string, kind: TaskKind, summary: string, prompt: string, system: string): number => {
  const r = run("INSERT INTO tasks (app_id, kind, summary, prompt, system) VALUES (?, ?, ?, ?, ?)",
    appId, kind, summary.slice(0, 200), String(prompt || "").slice(0, PROMPT_MAX), String(system || "").slice(0, PROMPT_MAX));
  return Number(r.lastInsertRowid);
};

export const finishTask = (id: number, status: "done" | "error", detail: { result?: string; error?: string; usage?: any; tools?: TaskTool[] } = {}) => {
  const usage = detail.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const tools = JSON.stringify(detail.tools || []).slice(0, TOOLS_MAX);
  run(`UPDATE tasks SET status = ?, result = ?, error = ?, tools = ?, input_tokens = ?, output_tokens = ?,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
       WHERE id = ?`,
    status, String(detail.result || "").slice(0, RESULT_MAX), String(detail.error || "").slice(0, 4000), tools, inputTokens, outputTokens, id);
};

export const listTasks = (limit = 100): TaskSummary[] =>
  all<TaskSummary>(`SELECT id, app_id, kind, summary, status, substr(prompt, 1, 240) AS prompt, substr(result, 1, 240) AS result,
      error, json_array_length(tools) AS tool_count, input_tokens, output_tokens, started_at, finished_at, duration_ms
    FROM tasks ORDER BY id DESC LIMIT ?`, Math.min(500, limit));

export const getTask = (id: number): Task | null => one<Task>("SELECT * FROM tasks WHERE id = ?", id) ?? null;

export const runningCount = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'")?.n ?? 0;
