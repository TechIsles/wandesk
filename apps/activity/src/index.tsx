import { useEffect, useMemo, useState } from "react";
import "./style.css";

// Activity — the kernel's task record (every env.AI call from every app) plus running conversations.
// Left: the list. Right: one call in full.
type Kind = "ask" | "run" | "stream";
type Status = "running" | "done" | "error";
type Row = {
  id: number; thread_id: string; app_id: string; kind: Kind; summary: string; status: Status;
  prompt: string; error: string; tool_count: number;
  input_tokens: number; output_tokens: number; started_at: string; finished_at: string | null; duration_ms: number;
};
type Item = { seq: number; item: any; createdAt: string };
type Call = { task: Omit<Row, "prompt" | "tool_count">; messages: Item[] };
type Tool = { name: string; args: string; output: string };

// The thread is a list of Responses items; pull the pieces the detail pane shows out of it.
const textOf = (item: any) => (Array.isArray(item?.content) ? item.content.map((p: any) => p?.text || "").join("") : String(item?.content || ""));
const readThread = (messages: Item[]) => {
  const items = messages.map((m) => m.item);
  const system = items.filter((i) => i?.type === "message" && i.role === "system").map(textOf).join("\n");
  const prompt = items.filter((i) => i?.type === "message" && i.role === "user").map(textOf).join("\n\n");
  const assistant = items.filter((i) => i?.type === "message" && i.role === "assistant").map(textOf);
  const reasoning = items.filter((i) => i?.type === "reasoning").map((i) => (Array.isArray(i.summary) ? i.summary.map((p: any) => p?.text || "").join("") : "") || textOf(i)).filter(Boolean);
  const outputs = new Map<string, string>();
  for (const i of items) if (i?.type === "function_call_output") outputs.set(String(i.call_id), String(i.output ?? ""));
  const tools: Tool[] = items.filter((i) => i?.type === "function_call").map((i) => ({ name: String(i.name || ""), args: String(i.arguments || ""), output: outputs.get(String(i.call_id)) ?? "" }));
  return { system, prompt, reply: assistant[assistant.length - 1] || "", intermediate: assistant.slice(0, -1), reasoning, tools };
};
type Conv = { id: string; title: string };
type Filter = "all" | Status;

const REFRESH_MS = 2000;

const parseAt = (v: string | null) => (v ? new Date(v) : null);
const ago = (v: string | null) => {
  const d = parseAt(v);
  if (!d || Number.isNaN(d.getTime())) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const clock = (v: string | null) => { const d = parseAt(v); return d && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"; };
const duration = (ms: number, running: boolean, startedAt: string) => {
  const value = running ? Date.now() - (parseAt(startedAt)?.getTime() ?? Date.now()) : ms;
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1000)} s`;
};
const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const appLabel = (id: string) => (id === "chat" ? "Assistant" : id.charAt(0).toUpperCase() + id.slice(1));
const KIND_LABEL: Record<Kind, string> = { ask: "Completion", run: "Agent run", stream: "Agent run" };
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const prettyArgs = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

export default function Activity() {
  const [rows, setRows] = useState<Row[]>([]);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [error, setError] = useState("");
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [a, r] = await Promise.all([
          fetch("/api/tasks?limit=300").then((x) => x.json()),
          fetch("/api/runs").then((x) => x.json()),
        ]);
        if (!alive) return;
        setRows(a.items || []);
        setConvs(r.conversations || []);
        setError("");
        tick((n) => n + 1);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // The selected call is fetched in full; while it runs, keep refreshing it so the reply and tools fill in.
  useEffect(() => {
    if (selected == null) { setCall(null); return; }
    let alive = true;
    const load = () => fetch(`/api/tasks/${selected}`).then((x) => x.json()).then((j) => { if (alive) setCall(j.item || null); }).catch(() => {});
    void load();
    const timer = setInterval(() => { if (call?.task.status === "running" || !call) void load(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [selected, call?.task.status]);

  const counts = useMemo(() => ({
    all: rows.length,
    running: rows.filter((i) => i.status === "running").length,
    done: rows.filter((i) => i.status === "done").length,
    error: rows.filter((i) => i.status === "error").length,
  }), [rows]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => (filter === "all" || r.status === filter) && (!q || `${r.app_id} ${r.summary} ${r.prompt}`.toLowerCase().includes(q)));
  }, [rows, filter, query]);
  const totals = useMemo(() => rows.reduce((t, r) => ({ input: t.input + r.input_tokens, output: t.output + r.output_tokens }), { input: 0, output: 0 }), [rows]);
  const live = counts.running + convs.length;
  const thread = useMemo(() => (call ? readThread(call.messages) : null), [call]);
  const task = call?.task;

  const TABS: Array<[Filter, string]> = [["all", "All"], ["running", "Running"], ["done", "Done"], ["error", "Error"]];

  return (
    <div className="act">
      <header className="act-head">
        <h1>Activity</h1>
        <span className="act-totals">{rows.length} calls · {tokens(totals.input)} in · {tokens(totals.output)} out</span>
        <span className={`act-live${live ? " on" : ""}`}><i />{live ? `${live} running` : "Idle"}</span>
      </header>

      <div className="act-body">
        <section className="act-left">
          {convs.length > 0 && (
            <div className="act-convs">
              {convs.map((c) => (
                <button key={c.id} className="act-conv" onClick={() => void fetch("/api/open-assistant")}>
                  <i className="dot" /><span className="act-conv-title">{c.title || "Conversation"}</span><span className="act-conv-hint">Assistant · open</span>
                </button>
              ))}
            </div>
          )}
          <div className="act-tools">
            <nav className="act-tabs">
              {TABS.map(([key, label]) => (
                <button key={key} className={`act-tab${filter === key ? " on" : ""}`} onClick={() => setFilter(key)}>
                  {label}<span className="act-count">{counts[key]}</span>
                </button>
              ))}
            </nav>
            <input className="act-search" placeholder="Filter by app or text" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {error && <div className="act-error">{error}</div>}
          <div className="act-list">
            {!shown.length && <div className="act-empty">{rows.length ? "Nothing matches." : "No AI calls recorded yet."}</div>}
            {shown.map((r) => (
              <button key={r.id} className={`act-row${selected === r.id ? " on" : ""}`} onClick={() => setSelected(r.id)}>
                <span className={`act-dot is-${r.status}`} />
                <span className="act-row-main">
                  <span className="act-row-top">
                    <span className="act-app">{appLabel(r.app_id)}</span>
                    <span className="act-kind">{KIND_LABEL[r.kind]}</span>
                    <span className="act-time">{ago(r.started_at)}</span>
                  </span>
                  <span className="act-summary">{r.summary}</span>
                  <span className="act-row-meta">
                    <span>{duration(r.duration_ms, r.status === "running", r.started_at)}</span>
                    {(r.input_tokens || r.output_tokens) ? <span>{tokens(r.input_tokens)} in · {tokens(r.output_tokens)} out</span> : null}
                    {r.tool_count ? <span>{r.tool_count} tool call{r.tool_count === 1 ? "" : "s"}</span> : null}
                    {r.status === "error" && <span className="act-row-err">{oneLine(r.error).slice(0, 80)}</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="act-detail">
          {!task || !thread ? (
            <div className="act-detail-empty">{selected == null ? "Select a task to see what was asked and what came back." : "Loading…"}</div>
          ) : (
            <>
              <div className="act-detail-head">
                <span className={`act-badge is-${task.status}`}>{task.status === "running" && <i className="spin" />}{task.status}</span>
                <h2>{task.summary}</h2>
                <div className="act-facts">
                  <span><b>App</b>{appLabel(task.app_id)}</span>
                  <span><b>Kind</b>{KIND_LABEL[task.kind]}</span>
                  <span><b>Started</b>{clock(task.started_at)}</span>
                  <span><b>Duration</b>{duration(task.duration_ms, task.status === "running", task.started_at)}</span>
                  <span><b>Tokens</b>{tokens(task.input_tokens)} in · {tokens(task.output_tokens)} out</span>
                  <span><b>Thread</b><code>{task.thread_id.slice(0, 8)}</code> · {call.messages.length} items</span>
                </div>
              </div>
              <div className="act-detail-body">
                {task.error && <Block title="Error" tone="error" text={task.error} />}
                <Block title="Prompt" text={thread.prompt || "(empty)"} mono={false} />
                {thread.system && <Block title="System prompt" text={thread.system} collapsed />}
                {thread.reasoning.length > 0 && <Block title="Reasoning" text={thread.reasoning.join("\n\n")} mono={false} collapsed />}
                {thread.tools.length > 0 && (
                  <div className="act-block">
                    <div className="act-block-title">Tool calls <span>{thread.tools.length}</span></div>
                    <div className="act-toolist">
                      {thread.tools.map((t, i) => (
                        <details key={i} className="act-tool">
                          <summary><code>{t.name}</code><span className="act-tool-args">{oneLine(t.args).slice(0, 140)}</span></summary>
                          <div className="act-tool-body">
                            <div className="act-tool-label">Arguments</div>
                            <pre>{prettyArgs(t.args)}</pre>
                            <div className="act-tool-label">Output</div>
                            <pre>{t.output || (task.status === "running" ? "Running…" : "(no output)")}</pre>
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
                {thread.intermediate.length > 0 && <Block title="Intermediate text" text={thread.intermediate.join("\n\n")} mono={false} collapsed />}
                <Block title={task.status === "running" ? "Reply (in progress)" : "Reply"} text={thread.reply || (task.status === "running" ? "Waiting for the model…" : "(no text)")} mono={false} />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Block({ title, text, tone, mono = true, collapsed = false }: { title: string; text: string; tone?: "error"; mono?: boolean; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div className={`act-block${tone ? ` is-${tone}` : ""}`}>
      <button className="act-block-title" onClick={() => setOpen(!open)}>
        <i className={`chev${open ? " open" : ""}`} />{title}<span>{text.length.toLocaleString()} chars</span>
      </button>
      {open && <pre className={mono ? "" : "prose"}>{text}</pre>}
    </div>
  );
}
