import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import "./style.css";

// Browser — tabs, a toolbar and the app's own pages (new tab, history). The web page itself is not
// in this document at all: it is a real Chromium view the shell parks over the grey rectangle below,
// so any site loads, logins persist, and DevTools work. All this app does is tell the shell where
// that rectangle is and what to do next.
//
// Everything that is drawn *above* the page — the address-bar suggestions — takes the page off screen
// first (place(null)); the shell hands back a snapshot, which stays painted in the same spot, so the
// swap is invisible. Panels that sit beside the page (find bar, AI) simply make the rectangle smaller.

declare const window: any;
const wd = () => window.wandesk;

type Tab = {
  key: number;
  viewId: number | null;
  url: string;
  title: string;
  favicon: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  snapshot: string;
  zoom: number;
  error: string;
  page: "new" | "history" | "web";
};
type Item = { id?: number; url: string; title: string; visits?: number; bookmark?: number; visited_at?: string };
type Start = { bookmarks: Item[]; recent: Item[]; top: Item[]; settings: Record<string, string> };

const ENGINES: Record<string, { name: string; url: (q: string) => string }> = {
  bing: { name: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  google: { name: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  duckduckgo: { name: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
};
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
const looksLikeUrl = (s: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s) ||
  (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|\?|#|$)/i.test(s) && !/\s/.test(s));
const toUrl = (input: string, engine: string) => {
  const s = input.trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (looksLikeUrl(s)) return `https://${s}`;
  return (ENGINES[engine] || ENGINES.bing).url(s);
};
const get = (path: string) => fetch(path).then((r) => r.json());
const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const Icon = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const P = {
  back: "M15 5l-7 7 7 7", forward: "M9 5l7 7-7 7", reload: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5", stop: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14", close: "M6 6l12 12M18 6L6 18", star: "M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.6-5 2.6 1-5.5-4-3.9 5.6-.8z",
  dots: "M12 6h.01M12 12h.01M12 18h.01", spark: "M12 4l1.8 4.7L18.5 10l-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.3z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5", clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
};

export default function Browser() {
  const [ok, setOk] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ key: 1, viewId: null, url: "", title: "New Tab", favicon: "", loading: false, canBack: false, canForward: false, snapshot: "", zoom: 1, error: "", page: "new" }]);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [suggest, setSuggest] = useState<Item[]>([]);
  const [pick, setPick] = useState(0);
  const [start, setStart] = useState<Start>({ bookmarks: [], recent: [], top: [], settings: {} });
  const [history, setHistory] = useState<Item[]>([]);
  const [find, setFind] = useState<{ open: boolean; text: string; active: number; total: number }>({ open: false, text: "", active: 0, total: 0 });
  const [menu, setMenu] = useState(false);
  const [ai, setAi] = useState<{ open: boolean; busy: boolean; question: string; answer: string; error: string }>({ open: false, busy: false, question: "", answer: "", error: "" });
  const [notice, setNotice] = useState("");

  const pageBox = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const seq = useRef(1);
  const sent = useRef("");
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;

  const tab = tabs[active];
  const engine = start.settings.engine || "bing";
  const bookmarked = useMemo(() => start.bookmarks.some((b) => b.url === tab?.url), [start.bookmarks, tab?.url]);
  // The page must not paint under anything the app draws on top of it
  const hidden = !tab || tab.page !== "web" || !tab.viewId || (editing && suggest.length > 0);

  const patch = useCallback((key: number, next: Partial<Tab>) => setTabs((list) => list.map((t) => (t.key === key ? { ...t, ...next } : t))), []);
  const say = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(""), 3500); };

  useEffect(() => { void wd().web.available().then(setOk); void get("/api/start").then(setStart); }, []);

  // ── Where the page may paint. Recomputed after every render; the shell keeps it glued to the window ──
  const report = useCallback(() => {
    const t = tabsRef.current[activeRef.current];
    const el = pageBox.current;
    if (!t?.viewId || !el) return;
    const hide = t.page !== "web";
    const box = el.getBoundingClientRect();
    const rect = hide ? null : { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) };
    const key = `${t.viewId}:${rect ? `${rect.x},${rect.y},${rect.w},${rect.h}` : "off"}`;
    if (key === sent.current) return;
    sent.current = key;
    void wd().web.place(t.viewId, rect).catch(() => {});
  }, []);
  useLayoutEffect(() => { if (hidden && tab?.viewId) { const k = `${tab.viewId}:off`; if (sent.current !== k) { sent.current = k; void wd().web.place(tab.viewId, null).catch(() => {}); } } else report(); });
  useEffect(() => {
    const el = pageBox.current;
    if (!el) return;
    const observer = new ResizeObserver(() => report());
    observer.observe(el);
    window.addEventListener("resize", report);
    return () => { observer.disconnect(); window.removeEventListener("resize", report); };
  }, [report]);

  // ── What the shell reports back about every page ──
  useEffect(() => wd().on("web", (e: any) => {
    const owner = tabsRef.current.find((t) => t.viewId === e.id);
    if (e.kind === "download") { say(e.state === "started" ? `Downloading ${e.name}` : e.state === "completed" ? `Saved ${e.name}` : `Download failed: ${e.name}`); return; }
    if (e.kind === "popup") { openTab(String(e.url || ""), true); return; }
    if (!owner) return;
    if (e.kind === "state") {
      patch(owner.key, { url: e.url, title: e.title || host(e.url) || "Untitled", loading: e.loading, canBack: e.canBack, canForward: e.canForward, error: e.loading ? "" : owner.error });
      if (!e.loading && e.url && e.url !== owner.url) void post("/api/visit", { url: e.url, title: e.title }).then(() => get("/api/start").then(setStart));
      if (owner.key === tabsRef.current[activeRef.current]?.key && !editing) setDraft(e.url);
    }
    if (e.kind === "favicon") patch(owner.key, { favicon: String(e.url || "") });
    if (e.kind === "snapshot") patch(owner.key, { snapshot: String(e.data || "") });
    if (e.kind === "failed") patch(owner.key, { error: `${e.description || "Could not load this page"} (${e.code})` });
    if (e.kind === "found") setFind((f) => ({ ...f, active: e.active, total: e.total }));
    if (e.kind === "key") shortcut(String(e.action || ""));
  }), [editing, patch]);

  // ── Tabs ──
  const blank = (key: number): Tab => ({ key, viewId: null, url: "", title: "New Tab", favicon: "", loading: false, canBack: false, canForward: false, snapshot: "", zoom: 1, error: "", page: "new" });
  const openTab = (url = "", focus = true) => {
    const key = ++seq.current;
    const index = tabsRef.current.length;
    setTabs((list) => [...list, { ...blank(key), title: url ? host(url) : "New Tab", loading: Boolean(url), page: url ? "web" : "new" }]);
    if (focus) { setActive(index); sent.current = ""; setDraft(url); }
    if (url) void wd().web.open(url).then(({ id }: { id: number }) => { sent.current = ""; patch(key, { viewId: id }); }).catch((err: Error) => patch(key, { error: err.message, loading: false }));
    else if (focus) { setEditing(true); window.setTimeout(() => address.current?.focus(), 30); }
  };
  const closeTab = (index: number) => {
    const list = tabsRef.current;
    const victim = list[index];
    if (!victim) return;
    if (victim.viewId) void wd().web.close(victim.viewId).catch(() => {});
    sent.current = "";
    if (list.length === 1) { setTabs([blank(++seq.current)]); setActive(0); setDraft(""); setEditing(false); return; }
    const rest = list.filter((_, i) => i !== index);
    const next = index < activeRef.current ? activeRef.current - 1 : Math.min(activeRef.current, rest.length - 1);
    setTabs(rest);
    setActive(next);
    setDraft(rest[next]?.url || "");
  };

  // ── Navigation ──
  const navigate = (input: string) => {
    const href = toUrl(input, engine);
    if (!href || !tab) return;
    setEditing(false);
    setSuggest([]);
    setDraft(href);
    if (tab.viewId) { patch(tab.key, { loading: true, error: "", page: "web" }); void wd().web.navigate(tab.viewId, href).catch(() => {}); return; }
    patch(tab.key, { loading: true, error: "", page: "web", title: host(href) });
    void wd().web.open(href).then(({ id }: { id: number }) => { sent.current = ""; patch(tab.key, { viewId: id }); }).catch((err: Error) => patch(tab.key, { error: err.message }));
  };
  const act = (method: "back" | "forward" | "reload" | "stop" | "devtools" | "print") => {
    if (!tab?.viewId) return;
    void wd().web[method](tab.viewId).catch(() => {});
  };
  const setZoom = (factor: number) => {
    if (!tab?.viewId) return;
    const next = Math.max(0.25, Math.min(5, factor));
    patch(tab.key, { zoom: next });
    void wd().web.zoom(tab.viewId, next).catch(() => {});
  };
  const home = () => { if (tab) { patch(tab.key, { page: "new" }); setDraft(""); setEditing(true); window.setTimeout(() => address.current?.focus(), 30); } };

  const shortcut = (action: string) => {
    if (action === "address") { setEditing(true); window.setTimeout(() => { address.current?.focus(); address.current?.select(); }, 20); }
    else if (action === "newTab") openTab();
    else if (action === "closeTab") closeTab(activeRef.current);
    else if (action === "reload") act("reload");
    else if (action === "find") { setFind((f) => ({ ...f, open: true })); window.setTimeout(() => document.getElementById("find-input")?.focus(), 20); }
    else if (action === "back") act("back");
    else if (action === "forward") act("forward");
    else if (action === "escape") { setEditing(false); setSuggest([]); setMenu(false); if (find.open) stopFind(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const map: Record<string, string> = { l: "address", t: "newTab", w: "closeTab", r: "reload", f: "find", "[": "back", "]": "forward" };
      if (mod && map[e.key.toLowerCase()]) { e.preventDefault(); shortcut(map[e.key.toLowerCase()]); }
      else if (e.key === "Escape") shortcut("escape");
      else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.findIndex((z) => z >= (tab?.zoom || 1)) + 1)] || 1); }
      else if (mod && e.key === "-") { e.preventDefault(); setZoom(ZOOMS[Math.max(0, ZOOMS.findIndex((z) => z >= (tab?.zoom || 1)) - 1)] || 1); }
      else if (mod && e.key === "0") { e.preventDefault(); setZoom(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Find in page ──
  const runFind = (text: string, next = false) => {
    setFind((f) => ({ ...f, text, ...(text ? {} : { active: 0, total: 0 }) }));
    if (!tab?.viewId) return;
    if (text) void wd().web.find(tab.viewId, text, true, next).catch(() => {});
    else void wd().web.stopFind(tab.viewId).catch(() => {});
  };
  const stopFind = () => { setFind({ open: false, text: "", active: 0, total: 0 }); if (tab?.viewId) void wd().web.stopFind(tab.viewId).catch(() => {}); };

  // ── Bookmarks, history, AI ──
  const toggleBookmark = async () => {
    if (!tab?.url) return;
    const r = await post("/api/bookmark", { url: tab.url, title: tab.title, remove: bookmarked });
    if (r.error) return say(r.error);
    setStart((s) => ({ ...s, bookmarks: r.bookmarks }));
    say(bookmarked ? "Bookmark removed" : "Bookmarked");
  };
  const showHistory = async () => { setMenu(false); setHistory((await get("/api/history")).items || []); if (tab) patch(tab.key, { page: "history" }); };
  const askAi = async (question: string) => {
    if (!tab?.viewId) return;
    setAi((s) => ({ ...s, open: true, busy: true, answer: "", error: "", question }));
    try {
      const text = await wd().web.text(tab.viewId);
      const r = await post("/api/ask", { question, text, url: tab.url, title: tab.title });
      setAi((s) => ({ ...s, busy: false, answer: r.text || "", error: r.error || "" }));
    } catch (e: any) {
      setAi((s) => ({ ...s, busy: false, error: String(e?.message || e) }));
    }
  };

  // ── Address bar ──
  const onDraft = (value: string) => {
    setDraft(value);
    setPick(0);
    if (!value.trim()) { setSuggest([]); return; }
    void get(`/api/suggest?q=${encodeURIComponent(value)}`).then((r) => setSuggest(r.items || [])).catch(() => setSuggest([]));
  };
  const rows = useMemo(() => {
    const query = draft.trim();
    const out: Array<{ kind: "search" | "url"; url: string; title: string; bookmark?: boolean }> = [];
    if (query && !looksLikeUrl(query)) out.push({ kind: "search", url: toUrl(query, engine), title: query });
    for (const s of suggest) out.push({ kind: "url", url: s.url, title: s.title || host(s.url), bookmark: Boolean(s.bookmark) });
    return out.slice(0, 8);
  }, [draft, suggest, engine]);

  if (ok === false) {
    return (
      <div className="bw-gate">
        <div className="bw-gate-icon">🌐</div>
        <h2>The Browser needs the desktop app</h2>
        <p>Pages here are real Chromium views owned by the Wandesk shell, not frames inside a page. Open this app from the Wandesk desktop app and it works as it should.</p>
      </div>
    );
  }

  return (
    <div className="bw">
      <div className="bw-tabs">
        {tabs.map((t, i) => (
          <button key={t.key} className={`bw-tab${i === active ? " on" : ""}`} onClick={() => { setActive(i); sent.current = ""; setDraft(t.url); setEditing(false); }}>
            <span className="bw-tab-icon">{t.loading ? <i className="bw-spin" /> : t.favicon ? <img src={t.favicon} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : <span className="bw-tab-letter">{(t.title || "?").slice(0, 1).toUpperCase()}</span>}</span>
            <span className="bw-tab-title">{t.title}</span>
            <span className="bw-tab-x" onClick={(e) => { e.stopPropagation(); closeTab(i); }} title="Close tab"><Icon d={P.close} size={11} /></span>
          </button>
        ))}
        <button className="bw-newtab" onClick={() => openTab()} title="New tab"><Icon d={P.plus} size={14} /></button>
      </div>

      <div className="bw-bar">
        <button className="bw-icon" disabled={!tab?.canBack} onClick={() => act("back")} title="Back"><Icon d={P.back} /></button>
        <button className="bw-icon" disabled={!tab?.canForward} onClick={() => act("forward")} title="Forward"><Icon d={P.forward} /></button>
        <button className="bw-icon" onClick={() => act(tab?.loading ? "stop" : "reload")} title={tab?.loading ? "Stop" : "Reload"}><Icon d={tab?.loading ? P.stop : P.reload} /></button>
        <button className="bw-icon" onClick={home} title="New tab page"><Icon d={P.search} /></button>

        <div className={`bw-address${editing ? " on" : ""}`}>
          <input
            ref={address} value={draft} spellCheck={false} placeholder={`Search ${ENGINES[engine]?.name || "the web"} or enter an address`}
            onChange={(e) => onDraft(e.target.value)}
            onFocus={(e) => { setEditing(true); e.target.select(); }}
            onBlur={() => window.setTimeout(() => { setEditing(false); setSuggest([]); }, 120)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { const row = rows[pick]; navigate(row ? row.url : draft); (e.target as HTMLInputElement).blur(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setPick((p) => Math.min(rows.length - 1, p + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setPick((p) => Math.max(0, p - 1)); }
            }}
          />
          {tab?.url && <button className={`bw-icon bw-star${bookmarked ? " on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={toggleBookmark} title={bookmarked ? "Remove bookmark" : "Bookmark this page"}><Icon d={P.star} size={14} /></button>}
          {editing && rows.length > 0 && (
            <div className="bw-suggest">
              {rows.map((r, i) => (
                <button key={`${r.kind}${r.url}`} className={`bw-sg${i === pick ? " on" : ""}`} onMouseDown={(e) => { e.preventDefault(); navigate(r.url); }} onMouseEnter={() => setPick(i)}>
                  <span className="bw-sg-icon"><Icon d={r.kind === "search" ? P.search : r.bookmark ? P.star : P.clock} size={13} /></span>
                  <span className="bw-sg-title">{r.title}</span>
                  <span className="bw-sg-url">{r.kind === "search" ? `Search ${ENGINES[engine]?.name}` : host(r.url)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className={`bw-icon${ai.open ? " on" : ""}`} disabled={!tab?.viewId} onClick={() => setAi((s) => ({ ...s, open: !s.open }))} title="Ask about this page"><Icon d={P.spark} /></button>
        <div className="bw-menu-wrap">
          <button className={`bw-icon${menu ? " on" : ""}`} onClick={() => setMenu((m) => !m)} title="Menu"><Icon d={P.dots} /></button>
          {menu && (
            <>
              <div className="bw-scrim" onClick={() => setMenu(false)} />
              <div className="bw-menu">
                <div className="bw-menu-zoom">
                  <span>Zoom</span>
                  <button onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.findIndex((z) => z >= (tab?.zoom || 1)) - 1)] || 1)}>−</button>
                  <b>{Math.round((tab?.zoom || 1) * 100)}%</b>
                  <button onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.findIndex((z) => z >= (tab?.zoom || 1)) + 1)] || 1)}>+</button>
                  <button onClick={() => setZoom(1)}>Reset</button>
                </div>
                <button className="bw-mi" onClick={() => { setMenu(false); shortcut("find"); }}>Find on page<kbd>⌘F</kbd></button>
                <button className="bw-mi" onClick={showHistory}>History</button>
                <button className="bw-mi" onClick={() => { setMenu(false); act("print"); }}>Print…</button>
                <button className="bw-mi" onClick={() => { setMenu(false); act("devtools"); }}>Developer tools</button>
                <div className="bw-menu-sep" />
                <div className="bw-menu-engine">
                  <span>Search with</span>
                  {Object.entries(ENGINES).map(([id, e]) => (
                    <button key={id} className={engine === id ? "on" : ""} onClick={() => { setStart((s) => ({ ...s, settings: { ...s.settings, engine: id } })); void post("/api/settings", { engine: id }); }}>{e.name}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {find.open && (
        <div className="bw-find">
          <input id="find-input" value={find.text} placeholder="Find on page" autoFocus onChange={(e) => runFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runFind(find.text, true); if (e.key === "Escape") stopFind(); }} />
          <span className="bw-find-count">{find.text ? `${find.active}/${find.total}` : ""}</span>
          <button className="bw-icon" onClick={() => runFind(find.text, true)} title="Next"><Icon d={P.forward} size={13} /></button>
          <button className="bw-icon" onClick={stopFind} title="Close"><Icon d={P.close} size={13} /></button>
        </div>
      )}

      <div className="bw-body">
        <div className="bw-page" ref={pageBox}>
          {/* The live page paints over this. What is left visible is the last snapshot, so hiding it never shows a hole. */}
          {tab?.page === "web" && <div className="bw-snapshot" style={tab.snapshot ? { backgroundImage: `url(${tab.snapshot})` } : undefined} />}
          {tab?.page === "web" && tab.error && (
            <div className="bw-error"><b>This page did not load</b><p>{tab.error}</p><button className="bw-btn" onClick={() => act("reload")}>Try again</button></div>
          )}
          {tab?.page === "new" && <NewTab start={start} onOpen={navigate} onHistory={showHistory} />}
          {tab?.page === "history" && (
            <div className="bw-sheet">
              <div className="bw-sheet-head"><h2>History</h2><span className="bw-sp" /><button className="bw-btn" onClick={async () => { await post("/api/history/clear", {}); setHistory([]); void get("/api/start").then(setStart); }}>Clear all</button><button className="bw-btn" onClick={() => tab && patch(tab.key, { page: tab.url ? "web" : "new" })}>Done</button></div>
              {!history.length && <div className="bw-empty">Nothing visited yet.</div>}
              <div className="bw-list">
                {history.map((h) => (
                  <button key={h.id} className="bw-row" onClick={() => navigate(h.url)}>
                    <span className="bw-row-title">{h.title || host(h.url)}</span><span className="bw-row-url">{host(h.url)}</span><span className="bw-row-time">{String(h.visited_at || "").slice(5, 16)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {ai.open && (
          <aside className="bw-ai">
            <div className="bw-ai-head"><Icon d={P.spark} size={14} /><b>This page</b><span className="bw-sp" /><button className="bw-icon" onClick={() => setAi((s) => ({ ...s, open: false }))}><Icon d={P.close} size={13} /></button></div>
            <div className="bw-ai-quick">
              <button onClick={() => askAi("")}>Summarize</button>
              <button onClick={() => askAi("What are the key facts and numbers on this page?")}>Key facts</button>
              <button onClick={() => askAi("Explain this page in plain language.")}>Explain</button>
            </div>
            <div className="bw-ai-body">
              {ai.busy && <div className="bw-ai-wait">Reading the page…</div>}
              {ai.error && <div className="bw-ai-error">{ai.error}</div>}
              {ai.answer && <div className="bw-ai-answer" dangerouslySetInnerHTML={{ __html: marked.parse(ai.answer, { async: false }) as string }} />}
              {!ai.busy && !ai.answer && !ai.error && <div className="bw-ai-hint">Ask anything about the page you are reading. The answer comes from the page text, not from a search.</div>}
            </div>
            <form className="bw-ai-ask" onSubmit={(e) => { e.preventDefault(); const q = ai.question.trim(); if (q) void askAi(q); }}>
              <input value={ai.question} placeholder="Ask about this page" onChange={(e) => setAi((s) => ({ ...s, question: e.target.value }))} />
              <button className="bw-btn primary" disabled={ai.busy}>Ask</button>
            </form>
          </aside>
        )}
      </div>

      {notice && <div className="bw-notice">{notice}</div>}
    </div>
  );
}

function NewTab({ start, onOpen, onHistory }: { start: Start; onOpen: (url: string) => void; onHistory: () => void }) {
  const tiles = start.top.length ? start.top : start.bookmarks.slice(0, 12);
  return (
    <div className="bw-new">
      <div className="bw-new-inner">
        <h1>Browser</h1>
        <p className="bw-new-sub">Real pages, real sessions. Type an address above, or pick up where you left off.</p>
        {start.bookmarks.length > 0 && (
          <>
            <h3>Bookmarks</h3>
            <div className="bw-chips">{start.bookmarks.slice(0, 16).map((b) => <button key={b.url} className="bw-chip" onClick={() => onOpen(b.url)} title={b.url}>{b.title || host(b.url)}</button>)}</div>
          </>
        )}
        {tiles.length > 0 && (
          <>
            <h3>Most visited</h3>
            <div className="bw-tiles">
              {tiles.map((t) => (
                <button key={t.url} className="bw-tile" onClick={() => onOpen(t.url)} title={t.url}>
                  <span className="bw-tile-letter">{host(t.url).slice(0, 1).toUpperCase()}</span>
                  <span className="bw-tile-name">{t.title || host(t.url)}</span>
                  <span className="bw-tile-host">{host(t.url)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {start.recent.length > 0 && (
          <>
            <h3>Recent<button className="bw-more" onClick={onHistory}>All history</button></h3>
            <div className="bw-list">
              {start.recent.slice(0, 8).map((r) => (
                <button key={r.url} className="bw-row" onClick={() => onOpen(r.url)}>
                  <span className="bw-row-title">{r.title || host(r.url)}</span><span className="bw-row-url">{host(r.url)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
