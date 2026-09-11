import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import "./style.css";

// Store — catalog on the left, one app on the right; a second view for the apps in this workspace (publish).
type CatalogApp = { id: string; name: string; icon: string; description: string; author: string; version: string; downloads: number; has_source: boolean; package_bytes: number; updated_at: string; status?: string; owner_email?: string };
type Detail = { app: CatalogApp; readme: string; versions: Array<{ version: string; notes: string; package_bytes: number; created_at: string }> };
type Installed = { id: string; name: string; icon: string; version: string; author: string; hasSource: boolean; installedVersion: string; modified: boolean };
type View = "catalog" | "mine";

const bytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (v: string) => { const d = new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z"); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }); };
const newer = (a: string, b: string) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] || 0) > (pb[i] || 0); return false; };
const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

export default function Store() {
  const [view, setView] = useState<View>("catalog");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string>(""); // "<action>:<id>"
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [mine, setMine] = useState<{ apps: CatalogApp[]; admin: boolean } | null>(null);
  const [pending, setPending] = useState<CatalogApp[]>([]);
  const [mineError, setMineError] = useState("");

  const say = (text: string, tone: "ok" | "bad" = "ok") => { setNotice({ text, tone }); window.setTimeout(() => setNotice(null), 4000); };

  const loadCatalog = (q = query) =>
    fetch(`/api/catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setCatalog(j.apps || []); setCatalogError(""); })
      .catch((e) => setCatalogError(e instanceof Error ? e.message : "Could not reach the store"));
  const loadInstalled = () => fetch("/api/installed").then((r) => r.json()).then((j) => setInstalled(j.apps || [])).catch(() => {});
  const loadMine = () =>
    fetch("/api/mine").then((r) => r.json()).then(async (j) => {
      if (j.error) { setMine(null); setMineError(j.error); return; }
      setMine({ apps: j.apps || [], admin: Boolean(j.admin) }); setMineError("");
      if (j.admin) setPending((await fetch("/api/pending").then((r) => r.json()).catch(() => ({}))).apps || []);
    }).catch((e) => setMineError(e instanceof Error ? e.message : "Could not reach the store"));

  useEffect(() => { void loadCatalog(""); void loadInstalled(); }, []);
  useEffect(() => { const t = window.setTimeout(() => void loadCatalog(query), 250); return () => window.clearTimeout(t); }, [query]);
  useEffect(() => { if (view === "mine") { void loadInstalled(); void loadMine(); } }, [view]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let alive = true;
    fetch(`/api/catalog/${selected}`).then((r) => r.json()).then((j) => { if (alive && !j.error) setDetail(j); }).catch(() => {});
    return () => { alive = false; };
  }, [selected]);

  const installedById = useMemo(() => Object.fromEntries(installed.map((a) => [a.id, a])), [installed]);
  const stateOf = (app: CatalogApp) => {
    const local = installedById[app.id];
    if (!local) return "absent" as const;
    if (local.version && newer(app.version, local.version)) return "update" as const;
    return "installed" as const;
  };

  const install = async (app: CatalogApp, force = false) => {
    setBusy(`install:${app.id}`);
    try {
      const r = await post("/api/install", { id: app.id, version: app.version, force });
      if (r.error) throw new Error(r.error);
      if (r.modified) {
        if (confirm(`${app.name} was modified in this workspace. Updating replaces your changes with version ${app.version}. Continue?`)) return install(app, true);
        return;
      }
      say(`${app.name} ${force || installedById[app.id] ? "updated" : "installed"} (${r.version}).`);
      await loadInstalled();
    } catch (e) { say(e instanceof Error ? e.message : "Install failed", "bad"); }
    finally { setBusy(""); }
  };
  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove ${name} from this desktop? Its data stays in the workspace store.`)) return;
    setBusy(`remove:${id}`);
    try {
      const r = await post("/api/remove", { id });
      if (r.error) throw new Error(r.error);
      say(`${name} removed.`);
      await loadInstalled();
    } catch (e) { say(e instanceof Error ? e.message : "Remove failed", "bad"); }
    finally { setBusy(""); }
  };
  const open = (id: string) => void post("/api/open", { id });
  const publish = async (app: Installed) => {
    const notes = prompt(`Publish ${app.name} ${app.version || ""} to the store.\nRelease notes (optional):`, "");
    if (notes === null) return;
    setBusy(`publish:${app.id}`);
    try {
      const r = await post("/api/publish", { id: app.id, notes });
      if (r.error) throw new Error(r.error);
      say(r.status === "approved" ? `${app.name} ${r.version} is live in the store.` : `${app.name} ${r.version} submitted; it appears once reviewed.`);
      await loadMine(); await loadCatalog(); await loadInstalled();
    } catch (e) { say(e instanceof Error ? e.message : "Publish failed", "bad"); }
    finally { setBusy(""); }
  };
  const reviewApp = async (id: string, status: "approved" | "rejected") => {
    setBusy(`review:${id}`);
    try {
      const r = await post("/api/review", { id, status });
      if (r.error) throw new Error(r.error);
      await loadMine(); await loadCatalog();
    } catch (e) { say(e instanceof Error ? e.message : "Review failed", "bad"); }
    finally { setBusy(""); }
  };

  const ActionButton = ({ app }: { app: CatalogApp }) => {
    const state = stateOf(app);
    const working = busy === `install:${app.id}`;
    if (state === "installed") return <button className="st-btn" onClick={() => open(app.id)}>Open</button>;
    return (
      <button className="st-btn is-primary" disabled={working} onClick={() => void install(app)}>
        {working ? "Working…" : state === "update" ? `Update to ${app.version}` : "Install"}
      </button>
    );
  };

  return (
    <div className="st">
      <header className="st-head">
        <nav className="st-tabs">
          <button className={`st-tab${view === "catalog" ? " on" : ""}`} onClick={() => setView("catalog")}>Catalog</button>
          <button className={`st-tab${view === "mine" ? " on" : ""}`} onClick={() => setView("mine")}>Your apps</button>
        </nav>
        {view === "catalog" && <input className="st-search" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />}
        {notice && <span className={`st-notice is-${notice.tone}`}>{notice.text}</span>}
      </header>

      {view === "catalog" ? (
        <div className="st-body">
          <section className="st-list">
            {catalogError && <div className="st-error">{catalogError}</div>}
            {!catalogError && !catalog.length && <div className="st-empty">{query ? "No apps match." : "The catalog is empty."}</div>}
            {catalog.map((app) => {
              const state = stateOf(app);
              return (
                <button key={app.id} className={`st-card${selected === app.id ? " on" : ""}`} onClick={() => setSelected(app.id)}>
                  <span className="st-card-icon">{app.icon}</span>
                  <span className="st-card-main">
                    <span className="st-card-top"><span className="st-card-name">{app.name}</span><span className="st-card-ver">{app.version}</span></span>
                    <span className="st-card-desc">{app.description}</span>
                    <span className="st-card-meta">
                      <span>{app.author}</span>
                      <span>{app.downloads} installs</span>
                      {state === "installed" && <span className="st-pill">Installed</span>}
                      {state === "update" && <span className="st-pill is-update">Update available</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>

          <section className="st-detail">
            {!detail ? (
              <div className="st-detail-empty">{selected ? "Loading…" : "Select an app."}</div>
            ) : (
              <>
                <div className="st-detail-head">
                  <span className="st-detail-icon">{detail.app.icon}</span>
                  <div className="st-detail-title">
                    <h2>{detail.app.name}</h2>
                    <div className="st-detail-sub">{detail.app.author} · {detail.app.version} · {bytes(detail.app.package_bytes)} · {detail.app.downloads} installs · updated {when(detail.app.updated_at)}</div>
                  </div>
                  <div className="st-detail-actions">
                    <ActionButton app={detail.app} />
                    {stateOf(detail.app) !== "absent" && <button className="st-btn" disabled={busy === `remove:${detail.app.id}`} onClick={() => void remove(detail.app.id, detail.app.name)}>Remove</button>}
                  </div>
                </div>
                <p className="st-detail-desc">{detail.app.description}</p>
                <div className="st-facts">
                  <span>{detail.app.has_source ? "Ships source — editable after install" : "Single-file app — edit public/ directly"}</span>
                  <span>Installs into <code>apps/{detail.app.id}/</code></span>
                  <span>Apps get every binding, including commands and your workspace files.</span>
                </div>
                {detail.readme && <div className="st-readme" dangerouslySetInnerHTML={{ __html: marked.parse(detail.readme, { async: false }) as string }} />}
                {detail.versions.length > 1 && (
                  <div className="st-versions">
                    <div className="st-versions-title">Versions</div>
                    {detail.versions.map((v) => (
                      <div key={v.version} className="st-version"><b>{v.version}</b><span>{when(v.created_at)}</span>{v.notes && <em>{v.notes}</em>}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="st-mine">
          <section className="st-section">
            <h3>In this workspace</h3>
            <p className="st-hint">Every app under <code>apps/</code>. Publishing packs the directory (without <code>node_modules</code> and <code>data.db</code>) and uploads it under your Wandesk account; apps with <code>package.json</code> must include <code>src/</code>.</p>
            {mineError && <div className="st-error">{mineError}</div>}
            <div className="st-rows">
              {installed.map((a) => {
                const published = mine?.apps.find((p) => p.id === a.id);
                return (
                  <div key={a.id} className="st-row">
                    <span className="st-row-icon">{a.icon}</span>
                    <span className="st-row-main">
                      <span className="st-row-name">{a.name} <code>{a.id}</code></span>
                      <span className="st-row-meta">
                        <span>{a.version ? `v${a.version}` : "no version in app.json"}</span>
                        {a.author && <span>{a.author}</span>}
                        <span>{a.hasSource ? "has src/" : "no src/"}</span>
                        {a.modified && <span className="st-pill is-update">modified locally</span>}
                        {published && <span className="st-pill">{published.status === "approved" ? `in store · v${published.version}` : `${published.status} · v${published.version}`}</span>}
                      </span>
                    </span>
                    <button className="st-btn is-primary" disabled={!!mineError || busy === `publish:${a.id}` || !a.version} onClick={() => void publish(a)}>
                      {busy === `publish:${a.id}` ? "Uploading…" : published ? "Publish update" : "Publish"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
          {mine?.admin && (
            <section className="st-section">
              <h3>Review queue</h3>
              {!pending.length && <p className="st-hint">Nothing waiting.</p>}
              <div className="st-rows">
                {pending.map((a) => (
                  <div key={a.id} className="st-row">
                    <span className="st-row-icon">{a.icon}</span>
                    <span className="st-row-main">
                      <span className="st-row-name">{a.name} <code>{a.id}</code> v{a.version}</span>
                      <span className="st-row-meta"><span>{a.author}</span><span>{a.owner_email}</span><span>{bytes(a.package_bytes)}</span></span>
                    </span>
                    <button className="st-btn is-primary" disabled={busy === `review:${a.id}`} onClick={() => void reviewApp(a.id, "approved")}>Approve</button>
                    <button className="st-btn" disabled={busy === `review:${a.id}`} onClick={() => void reviewApp(a.id, "rejected")}>Reject</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
