import { useEffect, useMemo, useState, type ReactNode } from "react";
import { marked } from "marked";
import "./style.css";

// Store — the catalog on the left, one app on the right (README, ratings and reviews, versions); "Your apps" for
// publishing from this workspace and following each version through review; "Review" for admin accounts.
// The store is for signed-in desktops: without an account the window shows the sign-in gate.

type Me = { signedIn: boolean; id?: number; email?: string; name?: string; admin?: boolean; error?: string };
type Version = { version: string; notes: string; package_bytes: number; has_source: boolean; status: "pending" | "approved" | "rejected" | "withdrawn"; review_note: string; reviewed_at: string | null; created_at: string };
type CatalogApp = {
  id: string; name: string; icon: string; description: string; author: string; version: string; listed: boolean; delisted_by: string; listing_note: string;
  downloads: number; rating: number; rating_count: number; has_source: boolean; package_bytes: number; created_at: string; updated_at: string;
};
type MineApp = CatalogApp & { versions: Version[] };
type Review = { user_id: number; user: string; rating: number; body: string; reply: string; replied_at: string | null; created_at: string; updated_at: string; mine: boolean };
type Detail = { app: CatalogApp; readme: string; versions: Version[]; reviews: Review[]; owner: boolean; admin: boolean };
type PendingVersion = Version & { id: string; name: string; icon: string; description: string; author: string; readme: string; on_sale: string; listed: boolean; owner_email: string };
type Installed = { id: string; name: string; icon: string; version: string; author: string; hasSource: boolean; installedVersion: string; modified: boolean };
type View = "catalog" | "mine" | "review";
type Ask = { title: string; message?: string; placeholder?: string; required?: boolean; confirm: string; danger?: boolean; initial?: string; resolve: (v: string | null) => void };

const bytes = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (v: string | null) => { if (!v) return ""; const d = new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z"); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }); };
const newer = (a: string, b: string) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] || 0) > (pb[i] || 0); return false; };
const get = (path: string) => fetch(path).then((r) => r.json());
const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const fail = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const expect = <T,>(r: T & { error?: string }): T => { if (r?.error) throw new Error(r.error); return r; };
const STATUS_LABEL: Record<Version["status"], string> = { pending: "Under review", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" };

// ── Small pieces ──────────────────────────────────────────────────────────────

const Stars = ({ value, size = 13 }: { value: number; size?: number }) => (
  <span className="st-stars" style={{ fontSize: size }} aria-label={`${value} of 5`}>
    {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= Math.round(value) ? "on" : ""}>★</span>)}
  </span>
);

const StarPicker = ({ value, onChange }: { value: number; onChange: (v: number) => void }) => {
  const [hover, setHover] = useState(0);
  return (
    <span className="st-stars is-pick" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" className={i <= (hover || value) ? "on" : ""} onMouseEnter={() => setHover(i)} onClick={() => onChange(i)} aria-label={`${i} of 5`}>★</button>
      ))}
    </span>
  );
};

const StatusPill = ({ status }: { status: Version["status"] }) => <span className={`st-pill is-${status}`}>{STATUS_LABEL[status]}</span>;

/** One modal for every question the store asks: a confirmation, or a confirmation with a text (reason, notes). */
const Dialog = ({ ask }: { ask: Ask }) => {
  const [text, setText] = useState(ask.initial || "");
  const hasText = ask.placeholder !== undefined;
  const ok = !hasText || !ask.required || text.trim().length > 0;
  return (
    <div className="st-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) ask.resolve(null); }}>
      <form className="st-dialog" onSubmit={(e) => { e.preventDefault(); if (ok) ask.resolve(text.trim()); }}>
        <h4>{ask.title}</h4>
        {ask.message && <p>{ask.message}</p>}
        {hasText && <textarea autoFocus rows={4} placeholder={ask.placeholder} value={text} onChange={(e) => setText(e.target.value)} />}
        <div className="st-dialog-actions">
          <button type="button" className="st-btn" onClick={() => ask.resolve(null)}>Cancel</button>
          <button type="submit" className={`st-btn ${ask.danger ? "is-danger" : "is-primary"}`} disabled={!ok}>{ask.confirm}</button>
        </div>
      </form>
    </div>
  );
};

const Markdown = ({ text }: { text: string }) => <div className="st-readme" dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) as string }} />;

// ── The app ───────────────────────────────────────────────────────────────────

export default function Store() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("catalog");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [mine, setMine] = useState<MineApp[]>([]);
  const [mineError, setMineError] = useState("");
  const [pending, setPending] = useState<PendingVersion[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  const say = (text: string, tone: "ok" | "bad" = "ok") => { setNotice({ text, tone }); window.setTimeout(() => setNotice(null), 4500); };
  const question = (q: Omit<Ask, "resolve">) => new Promise<string | null>((resolve) => setAsk({ ...q, resolve: (v) => { setAsk(null); resolve(v); } }));
  const run = async (key: string, work: () => Promise<void>, fallback: string) => {
    setBusy(key);
    try { await work(); } catch (e) { say(fail(e, fallback), "bad"); } finally { setBusy(""); }
  };

  const loadMe = () => get("/api/me").then(setMe).catch(() => setMe({ signedIn: false, error: "The Store is not reachable" }));
  const loadCatalog = (q = query) =>
    get(`/api/catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((j) => { setCatalog(expect(j).apps || []); setCatalogError(""); })
      .catch((e) => setCatalogError(fail(e, "The Store is not reachable")));
  const loadInstalled = () => get("/api/installed").then((j) => setInstalled(j.apps || [])).catch(() => {});
  const loadDetail = (id: string) =>
    get(`/api/catalog/${id}`).then((j) => { setDetail(expect(j)); setDetailError(""); }).catch((e) => { setDetail(null); setDetailError(fail(e, "Could not load this app")); });
  const loadMine = () => get("/api/mine").then((j) => { setMine(expect(j).apps || []); setMineError(""); }).catch((e) => setMineError(fail(e, "The Store is not reachable")));
  const loadPending = () => get("/api/pending").then((j) => setPending(expect(j).versions || [])).catch((e) => say(fail(e, "Could not load the review queue"), "bad"));

  useEffect(() => { void loadMe(); }, []);
  useEffect(() => {
    if (!me?.signedIn) return;
    void loadCatalog(""); void loadInstalled();
    if (me.admin) void loadPending();
  }, [me?.signedIn]);
  // Signed out: the account is connected in Settings, a different window — keep checking until it is
  useEffect(() => { if (me && !me.signedIn) { const t = window.setInterval(() => void loadMe(), 2000); return () => window.clearInterval(t); } }, [me?.signedIn]);
  useEffect(() => { if (!me?.signedIn) return; const t = window.setTimeout(() => void loadCatalog(query), 250); return () => window.clearTimeout(t); }, [query]);
  useEffect(() => {
    if (!me?.signedIn) return;
    if (view === "mine") { void loadInstalled(); void loadMine(); }
    if (view === "review") void loadPending();
  }, [view]);
  useEffect(() => { if (selected) void loadDetail(selected); else { setDetail(null); setDetailError(""); } }, [selected]);

  const installedById = useMemo(() => Object.fromEntries(installed.map((a) => [a.id, a])), [installed]);
  const stateOf = (app: CatalogApp) => {
    const local = installedById[app.id];
    if (!local) return "absent" as const;
    if (local.version && app.version && newer(app.version, local.version)) return "update" as const;
    return "installed" as const;
  };
  const refreshAll = () => Promise.all([loadCatalog(), loadInstalled(), selected ? loadDetail(selected) : Promise.resolve()]);

  // ── Workspace actions ──
  const install = (app: CatalogApp, force = false) => run(`install:${app.id}`, async () => {
    const r = expect(await post("/api/install", { id: app.id, version: app.version, force }));
    if (r.modified) {
      const go = await question({ title: `Replace your changes to ${app.name}?`, message: `This app was modified in this workspace. Updating replaces it with version ${app.version}; the app's data is kept.`, confirm: "Update", danger: true });
      if (go !== null) await install(app, true);
      return;
    }
    say(installedById[app.id] ? `${app.name} updated to ${r.version}.` : `${app.name} ${r.version} installed.`);
    await loadInstalled();
  }, "Installation failed");
  const remove = (id: string, name: string) => run(`remove:${id}`, async () => {
    const go = await question({ title: `Remove ${name} from this desktop?`, message: "The directory is deleted. The app's data stays in the workspace store and returns if the app is installed again.", confirm: "Remove", danger: true });
    if (go === null) return;
    expect(await post("/api/remove", { id }));
    say(`${name} removed.`);
    await loadInstalled();
  }, "Removal failed");
  const open = (id: string) => void post("/api/open", { id });

  // ── Publishing ──
  const publish = (app: Installed, published?: MineApp) => run(`publish:${app.id}`, async () => {
    const notes = await question({
      title: `Publish ${app.name} ${app.version}`,
      message: published ? `On sale now: ${published.version || "nothing yet"}. The new version is reviewed before it replaces it.` : "The app is reviewed before it appears in the catalog.",
      placeholder: "Release notes (optional)", confirm: "Publish",
    });
    if (notes === null) return;
    const r = expect(await post("/api/publish", { id: app.id, notes }));
    say(r.status === "approved" ? `${app.name} ${r.version} is on sale.` : `${app.name} ${r.version} submitted for review.`);
    await Promise.all([loadMine(), loadCatalog(), loadInstalled()]);
  }, "Publishing failed");
  const withdraw = (app: MineApp, v: Version) => run(`withdraw:${app.id}:${v.version}`, async () => {
    const go = await question({ title: `Withdraw ${app.name} ${v.version} from review?`, message: "A withdrawn version cannot be resubmitted; publish again under a higher version number.", confirm: "Withdraw", danger: true });
    if (go === null) return;
    expect(await post("/api/withdraw", { id: app.id, version: v.version }));
    await loadMine();
  }, "Withdrawal failed");
  const setListing = (app: CatalogApp, listed: boolean) => run(`listing:${app.id}`, async () => {
    const note = listed
      ? await question({ title: `Put ${app.name} back on sale?`, message: "The app returns to the catalog immediately.", confirm: "Relist" })
      : await question({ title: `Take ${app.name} down?`, message: "The app leaves the catalog and can no longer be installed. Desktops that already have it keep it.", placeholder: "Reason (shown to the publisher)", required: true, confirm: "Take down", danger: true });
    if (note === null) return;
    expect(await post("/api/listing", { id: app.id, listed, note }));
    say(listed ? `${app.name} is back on sale.` : `${app.name} was taken down.`);
    await Promise.all([refreshAll(), loadMine()]);
  }, "Listing change failed");

  // ── Review (admins) ──
  const decide = (v: PendingVersion, status: "approved" | "rejected") => run(`review:${v.id}:${v.version}`, async () => {
    const note = status === "approved"
      ? await question({ title: `Approve ${v.name} ${v.version}?`, message: v.on_sale ? `It replaces ${v.on_sale} in the catalog.` : "It becomes the first version on sale.", confirm: "Approve" })
      : await question({ title: `Reject ${v.name} ${v.version}`, placeholder: "Reason (shown to the publisher)", required: true, confirm: "Reject", danger: true });
    if (note === null) return;
    expect(await post("/api/review", { id: v.id, version: v.version, status, note }));
    say(status === "approved" ? `${v.name} ${v.version} approved.` : `${v.name} ${v.version} rejected.`);
    await Promise.all([loadPending(), loadCatalog()]);
  }, "Review failed");

  // ── Reviews ──
  const submitReview = (app: CatalogApp, rating: number, body: string) => run(`rate:${app.id}`, async () => {
    expect(await post("/api/reviews", { id: app.id, rating, body }));
    say("Your review is posted.");
    await refreshAll();
  }, "Could not post the review");
  const deleteReview = (app: CatalogApp, r: Review) => run(`unrate:${app.id}:${r.user_id}`, async () => {
    const go = await question({ title: r.mine ? "Delete your review?" : `Delete the review by ${r.user}?`, confirm: "Delete", danger: true });
    if (go === null) return;
    expect(await post("/api/reviews/delete", r.mine ? { id: app.id } : { id: app.id, user_id: r.user_id }));
    await refreshAll();
  }, "Could not delete the review");
  const reply = (app: CatalogApp, r: Review) => run(`reply:${app.id}:${r.user_id}`, async () => {
    const text = await question({ title: `Reply to ${r.user}`, message: r.body || undefined, placeholder: "Your reply as the publisher", initial: r.reply, confirm: r.reply ? "Update reply" : "Reply" });
    if (text === null) return;
    expect(await post("/api/reviews/reply", { id: app.id, user_id: r.user_id, reply: text }));
    await refreshAll();
  }, "Could not post the reply");

  // ── Screens ──
  if (!me) return <div className="st"><div className="st-gate"><p className="st-gate-sub">Connecting to the Store…</p></div></div>;
  if (!me.signedIn) {
    return (
      <div className="st">
        <div className="st-gate">
          <div className="st-gate-icon">🛍️</div>
          <h2>Sign in to use the Store</h2>
          <p className="st-gate-sub">The Store is for Wandesk accounts: browse and install apps, rate and review them, and publish your own. Connect your account in Settings; this window continues once you are signed in.</p>
          <button className="st-btn is-primary" onClick={() => void post("/api/settings", {})}>Open Settings</button>
          {me.error && <p className="st-gate-err">{me.error}</p>}
        </div>
      </div>
    );
  }

  const ActionButton = ({ app }: { app: CatalogApp }) => {
    const state = stateOf(app);
    const working = busy === `install:${app.id}`;
    if (state === "installed") return <button className="st-btn" onClick={() => open(app.id)}>Open</button>;
    if (!app.listed || !app.version) return null;
    return <button className="st-btn is-primary" disabled={working} onClick={() => void install(app)}>{working ? "Working…" : state === "update" ? `Update to ${app.version}` : "Install"}</button>;
  };

  return (
    <div className="st">
      <header className="st-head">
        <nav className="st-tabs">
          <button className={`st-tab${view === "catalog" ? " on" : ""}`} onClick={() => setView("catalog")}>Catalog</button>
          <button className={`st-tab${view === "mine" ? " on" : ""}`} onClick={() => setView("mine")}>Your apps</button>
          {me.admin && <button className={`st-tab${view === "review" ? " on" : ""}`} onClick={() => setView("review")}>Review{pending.length ? <span className="st-count">{pending.length}</span> : null}</button>}
        </nav>
        {view === "catalog" && <input className="st-search" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />}
        {notice && <span className={`st-notice is-${notice.tone}`}>{notice.text}</span>}
        <span className="st-account">{me.email}</span>
      </header>

      {view === "catalog" && (
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
                      {app.rating_count ? <span className="st-rating"><Stars value={app.rating} size={11} /> {app.rating.toFixed(1)} ({app.rating_count})</span> : <span>No ratings yet</span>}
                      <span>{app.downloads} installs</span>
                      {state === "installed" && <span className="st-pill is-approved">Installed</span>}
                      {state === "update" && <span className="st-pill is-pending">Update available</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>

          <section className="st-detail">
            {detailError && <div className="st-error">{detailError}</div>}
            {!detail && !detailError && <div className="st-detail-empty">{selected ? "Loading…" : "Select an app."}</div>}
            {detail && (
              <DetailPane
                detail={detail} busy={busy}
                actions={<><ActionButton app={detail.app} />{stateOf(detail.app) !== "absent" && <button className="st-btn" disabled={busy === `remove:${detail.app.id}`} onClick={() => void remove(detail.app.id, detail.app.name)}>Remove</button>}</>}
                onListing={(listed) => void setListing(detail.app, listed)}
                onSubmitReview={(rating, body) => void submitReview(detail.app, rating, body)}
                onDeleteReview={(r) => void deleteReview(detail.app, r)}
                onReply={(r) => void reply(detail.app, r)}
              />
            )}
          </section>
        </div>
      )}

      {view === "mine" && (
        <div className="st-page">
          <section className="st-section">
            <h3>In this workspace</h3>
            <p className="st-hint">Every app under <code>apps/</code>. Publishing packs the directory (without <code>node_modules</code> and <code>data.db</code>) and submits it under your account; apps with <code>package.json</code> must include <code>src/</code>. A submitted version is reviewed before it goes on sale; the version on sale stays available in the meantime.</p>
            {mineError && <div className="st-error">{mineError}</div>}
            <div className="st-rows">
              {installed.map((a) => {
                const published = mine.find((p) => p.id === a.id);
                return (
                  <div key={a.id} className="st-row is-tall">
                    <div className="st-row-line">
                      <span className="st-row-icon">{a.icon}</span>
                      <span className="st-row-main">
                        <span className="st-row-name">{a.name} <code>{a.id}</code></span>
                        <span className="st-row-meta">
                          <span>{a.version ? `v${a.version}` : "no version in app.json"}</span>
                          <span>{a.hasSource ? "ships src/" : "no src/"}</span>
                          {a.modified && <span className="st-pill is-pending">Modified locally</span>}
                          {published && (published.listed ? (published.version ? <span className="st-pill is-approved">On sale · {published.version}</span> : <span className="st-pill">Not on sale yet</span>) : <span className="st-pill is-rejected">Taken down</span>)}
                          {published && published.rating_count > 0 && <span className="st-rating"><Stars value={published.rating} size={11} /> {published.rating.toFixed(1)} ({published.rating_count})</span>}
                        </span>
                      </span>
                      {published && published.version && (published.listed
                        ? <button className="st-btn" disabled={busy === `listing:${a.id}`} onClick={() => void setListing(published, false)}>Take down</button>
                        : published.delisted_by !== "admin" && <button className="st-btn" disabled={busy === `listing:${a.id}`} onClick={() => void setListing(published, true)}>Relist</button>)}
                      <button className="st-btn is-primary" disabled={!!mineError || busy === `publish:${a.id}` || !a.version} onClick={() => void publish(a, published)}>
                        {busy === `publish:${a.id}` ? "Uploading…" : published ? "Publish update" : "Publish"}
                      </button>
                    </div>
                    {published && !published.listed && <div className="st-note is-bad">Taken down{published.delisted_by === "admin" ? " by Wandesk" : ""}: {published.listing_note}</div>}
                    {published && published.versions.length > 0 && (
                      <div className="st-vlist">
                        {published.versions.map((v) => (
                          <div key={v.version} className="st-version">
                            <b>{v.version}</b><StatusPill status={v.status} /><span>{when(v.reviewed_at || v.created_at)}</span>
                            {v.notes && <em>{v.notes}</em>}
                            {v.status === "rejected" && v.review_note && <span className="st-reason">Reason: {v.review_note}</span>}
                            {v.status === "pending" && <button className="st-link" disabled={busy === `withdraw:${a.id}:${v.version}`} onClick={() => void withdraw(published, v)}>Withdraw</button>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {view === "review" && me.admin && (
        <div className="st-page">
          <section className="st-section">
            <h3>Waiting for review</h3>
            <p className="st-hint">Each entry is one submitted version. Approving puts it on sale and makes its manifest the app's; rejecting sends the reason to the publisher, who can resubmit under a higher version.</p>
            {!pending.length && <div className="st-empty">Nothing is waiting.</div>}
            <div className="st-rows">
              {pending.map((v) => <PendingRow key={`${v.id}@${v.version}`} v={v} busy={busy === `review:${v.id}:${v.version}`} onDecide={(s) => void decide(v, s)} />)}
            </div>
          </section>
        </div>
      )}

      {ask && <Dialog ask={ask} />}
    </div>
  );
}

// ── Detail pane: README, ratings and reviews, versions ─────────────────────────

function DetailPane({ detail, busy, actions, onListing, onSubmitReview, onDeleteReview, onReply }: {
  detail: Detail; busy: string; actions: ReactNode;
  onListing: (listed: boolean) => void; onSubmitReview: (rating: number, body: string) => void; onDeleteReview: (r: Review) => void; onReply: (r: Review) => void;
}) {
  const { app } = detail;
  const manage = detail.owner || detail.admin;
  const myReview = detail.reviews.find((r) => r.mine);
  const [rating, setRating] = useState(myReview?.rating || 0);
  const [body, setBody] = useState(myReview?.body || "");
  const [editing, setEditing] = useState(false);
  useEffect(() => { setRating(myReview?.rating || 0); setBody(myReview?.body || ""); setEditing(false); }, [app.id, myReview?.updated_at]);
  const showForm = !detail.owner && (editing || !myReview);
  const histogram = [5, 4, 3, 2, 1].map((n) => ({ n, c: detail.reviews.filter((r) => r.rating === n).length }));
  const ratings = `${app.rating_count} ${app.rating_count === 1 ? "rating" : "ratings"}`;

  return (
    <>
      <div className="st-detail-head">
        <span className="st-detail-icon">{app.icon}</span>
        <div className="st-detail-title">
          <h2>{app.name}</h2>
          <div className="st-detail-sub">{app.author} · {app.version || "not on sale"} · {app.package_bytes ? `${bytes(app.package_bytes)} · ` : ""}{app.downloads} installs · updated {when(app.updated_at)}</div>
          <div className="st-detail-sub">{app.rating_count ? <><Stars value={app.rating} /> <b>{app.rating.toFixed(1)}</b> · {ratings}</> : "No ratings yet"}</div>
        </div>
        <div className="st-detail-actions">
          {actions}
          {manage && app.version && (app.listed
            ? <button className="st-btn" disabled={busy === `listing:${app.id}`} onClick={() => onListing(false)}>Take down</button>
            : (detail.admin || app.delisted_by !== "admin") && <button className="st-btn" disabled={busy === `listing:${app.id}`} onClick={() => onListing(true)}>Relist</button>)}
        </div>
      </div>
      {!app.listed && <div className="st-note is-bad">Taken down{app.delisted_by === "admin" ? " by Wandesk" : " by the publisher"}: {app.listing_note}</div>}
      <p className="st-detail-desc">{app.description}</p>
      <div className="st-facts">
        <span>{app.has_source ? "Ships source — editable after install" : "Single-file app — edit public/ directly"}</span>
        <span>Installs into <code>apps/{app.id}/</code></span>
        <span>Apps get every binding, including commands and your workspace files.</span>
      </div>
      {detail.readme && <Markdown text={detail.readme} />}

      <div className="st-block">
        <div className="st-block-title">Ratings and reviews</div>
        {app.rating_count > 0 && (
          <div className="st-summary">
            <div className="st-summary-big"><b>{app.rating.toFixed(1)}</b><Stars value={app.rating} size={15} /><span>{ratings}</span></div>
            <div className="st-bars">
              {histogram.map((h) => <div key={h.n} className="st-bar"><span>{h.n}</span><i><b style={{ width: `${(h.c / app.rating_count) * 100}%` }} /></i><span>{h.c}</span></div>)}
            </div>
          </div>
        )}
        {detail.owner && <p className="st-hint">Publishers cannot rate their own apps; you can reply to each review.</p>}
        {showForm && (
          <form className="st-review-form" onSubmit={(e) => { e.preventDefault(); if (rating) onSubmitReview(rating, body); }}>
            <div className="st-review-form-top"><span>{myReview ? "Edit your review" : "Rate this app"}</span><StarPicker value={rating} onChange={setRating} /></div>
            <textarea rows={3} placeholder="What works well, what does not (optional)" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
            <div className="st-dialog-actions">
              {myReview && <button type="button" className="st-btn" onClick={() => setEditing(false)}>Cancel</button>}
              <button type="submit" className="st-btn is-primary" disabled={!rating || busy === `rate:${app.id}`}>{myReview ? "Update review" : "Post review"}</button>
            </div>
          </form>
        )}
        {!detail.reviews.length && !showForm && <p className="st-hint">No reviews yet.</p>}
        <div className="st-reviews">
          {detail.reviews.map((r) => (
            <div key={r.user_id} className={`st-review${r.mine ? " is-mine" : ""}`}>
              <div className="st-review-head">
                <b>{r.mine ? "You" : r.user}</b><Stars value={r.rating} size={12} /><span>{when(r.updated_at)}</span>
                <span className="st-review-tools">
                  {r.mine && !editing && <button className="st-link" onClick={() => setEditing(true)}>Edit</button>}
                  {(r.mine || detail.admin) && <button className="st-link" disabled={busy === `unrate:${app.id}:${r.user_id}`} onClick={() => onDeleteReview(r)}>Delete</button>}
                  {detail.owner && <button className="st-link" disabled={busy === `reply:${app.id}:${r.user_id}`} onClick={() => onReply(r)}>{r.reply ? "Edit reply" : "Reply"}</button>}
                </span>
              </div>
              {r.body && <p>{r.body}</p>}
              {r.reply && <div className="st-reply"><b>{app.author} · publisher</b><span>{when(r.replied_at)}</span><p>{r.reply}</p></div>}
            </div>
          ))}
        </div>
      </div>

      {detail.versions.length > 0 && (
        <div className="st-block">
          <div className="st-block-title">Versions</div>
          {detail.versions.map((v) => (
            <div key={v.version} className="st-version">
              <b>{v.version}</b>{manage && <StatusPill status={v.status} />}<span>{when(v.reviewed_at || v.created_at)}</span>{v.notes && <em>{v.notes}</em>}
              {manage && v.status === "rejected" && v.review_note && <span className="st-reason">Reason: {v.review_note}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── One version in the review queue ───────────────────────────────────────────

function PendingRow({ v, busy, onDecide }: { v: PendingVersion; busy: boolean; onDecide: (s: "approved" | "rejected") => void }) {
  const [showReadme, setShowReadme] = useState(false);
  return (
    <div className="st-row is-tall">
      <div className="st-row-line">
        <span className="st-row-icon">{v.icon}</span>
        <span className="st-row-main">
          <span className="st-row-name">{v.name} <code>{v.id}</code> <b className="st-mono">{v.version}</b>{v.on_sale && <span className="st-muted"> replaces {v.on_sale}</span>}</span>
          <span className="st-row-meta"><span>{v.author}</span><span>{v.owner_email}</span><span>{bytes(v.package_bytes)}</span><span>{v.has_source ? "ships src/" : "no src/"}</span><span>submitted {when(v.created_at)}</span>{!v.listed && <span className="st-pill is-rejected">App taken down</span>}</span>
        </span>
        <button className="st-btn" onClick={() => setShowReadme((s) => !s)}>{showReadme ? "Hide README" : "README"}</button>
        <button className="st-btn" disabled={busy} onClick={() => onDecide("rejected")}>Reject</button>
        <button className="st-btn is-primary" disabled={busy} onClick={() => onDecide("approved")}>Approve</button>
      </div>
      <div className="st-note">{v.description}{v.notes && <><br /><em>Release notes: {v.notes}</em></>}</div>
      {showReadme && (v.readme ? <Markdown text={v.readme} /> : <p className="st-hint">This package has no APP.md.</p>)}
    </div>
  );
}
