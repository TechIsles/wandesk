import { useEffect, useMemo, useState } from "react";
import "./style.css";

// Activity — the kernel's ledger of AI calls (every env.AI call from every app) plus running conversations.
type Item = { id: number; app_id: string; summary: string; status: "running" | "done" | "error"; detail: string; created_at: string };
type Conv = { id: string; title: string };
type Filter = "all" | "running" | "done" | "error";

const REFRESH_MS = 3000;

const parseAt = (v: string) => new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z");
const when = (v: string) => {
  const d = parseAt(v);
  if (Number.isNaN(d.getTime())) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const appLabel = (id: string) => (id === "chat" ? "Assistant" : id.charAt(0).toUpperCase() + id.slice(1));

export default function Activity() {
  const [items, setItems] = useState<Item[]>([]);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [a, r] = await Promise.all([
          fetch("/api/activity?limit=200").then((x) => x.json()),
          fetch("/api/runs").then((x) => x.json()),
        ]);
        if (!alive) return;
        setItems(a.items || []);
        setConvs(r.conversations || []);
        setError("");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const counts = useMemo(() => ({
    all: items.length,
    running: items.filter((i) => i.status === "running").length,
    done: items.filter((i) => i.status === "done").length,
    error: items.filter((i) => i.status === "error").length,
  }), [items]);
  const shown = filter === "all" ? items : items.filter((i) => i.status === filter);

  const TABS: Array<[Filter, string]> = [["all", "All"], ["running", "Running"], ["done", "Done"], ["error", "Error"]];

  return (
    <div className="act">
      <header className="act-head">
        <h1>Activity</h1>
        <span className="act-live"><i className={counts.running || convs.length ? "on" : ""} />{counts.running + convs.length ? `${counts.running + convs.length} running` : "Idle"}</span>
      </header>

      {convs.length > 0 && (
        <section className="act-convs">
          <div className="act-convs-title">Running conversations</div>
          {convs.map((c) => <div key={c.id} className="act-conv"><i className="dot" />{c.title || "Conversation"}</div>)}
        </section>
      )}

      <nav className="act-tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={`act-tab${filter === key ? " on" : ""}`} onClick={() => setFilter(key)}>
            {label}<span className="act-count">{counts[key]}</span>
          </button>
        ))}
      </nav>

      {error && <div className="act-error">{error}</div>}

      <main className="act-list">
        {!shown.length && <div className="act-empty">{items.length ? "Nothing in this category." : "No AI calls recorded yet."}</div>}
        {shown.map((item) => (
          <div key={item.id} className={`act-row is-${item.status}${open === item.id ? " open" : ""}`} onClick={() => setOpen(open === item.id ? null : item.id)}>
            <span className={`act-status is-${item.status}`}>{item.status === "running" ? <i className="spin" /> : null}{item.status}</span>
            <span className="act-app">{appLabel(item.app_id)}</span>
            <span className="act-summary">{item.summary}</span>
            <span className="act-time">{when(item.created_at)}</span>
            {open === item.id && (
              <div className="act-detail">
                <div><b>App</b> {item.app_id}</div>
                <div><b>Started</b> {parseAt(item.created_at).toLocaleString()}</div>
                {item.detail && <pre>{item.detail}</pre>}
                {!item.detail && <div className="act-detail-none">No further detail.</div>}
              </div>
            )}
          </div>
        ))}
      </main>
    </div>
  );
}
