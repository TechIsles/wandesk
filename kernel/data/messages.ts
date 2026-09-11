// The shared message log: every item the runner produces, for every thread (conversations and tasks alike).
// The conversation store writes its own threads through kernel/conv; this is the same table for task threads.
import { all, one, run } from "./db.js";

export type MessageRow = { seq: number; item: any; createdAt: string };

export const appendMessage = (threadId: string, item: unknown): MessageRow => {
  const seq = Number(one<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?", threadId)?.seq) || 1;
  const at = new Date().toISOString();
  run("INSERT INTO messages (thread_id, seq, item_json, created_at) VALUES (?, ?, ?, ?)", threadId, seq, JSON.stringify(item), at);
  return { seq, item, createdAt: at };
};

export const listMessages = (threadId: string, limit = 500): MessageRow[] =>
  all<{ seq: number; item_json: string; created_at: string }>("SELECT seq, item_json, created_at FROM messages WHERE thread_id = ? ORDER BY seq LIMIT ?", threadId, limit)
    .map((r) => ({ seq: r.seq, item: JSON.parse(r.item_json), createdAt: r.created_at }));
