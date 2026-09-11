// Backend of this app: a Worker serving its own API and static assets. Frontend source lives in src/;
// after editing, run `npm install && npm run build` in this directory.
//
// The pages themselves are not this Worker's business — they are real Chromium views owned by the
// shell (window.wandesk.web). What lives here is what a browser has to remember: history, bookmarks,
// the search engine, and the AI that answers questions about whatever page is open.
const SCHEMA = `-- Browser · data model
-- One row per visit and one per bookmark; settings is the usual key/value pair.

CREATE TABLE IF NOT EXISTS app_browser_visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  visited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS app_browser_idx_visits ON app_browser_visits (visited_at DESC);

CREATE TABLE IF NOT EXISTS app_browser_bookmarks (
  url        TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_browser_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

let ready = false;
const ensure = async (env) => {
  if (ready) return;
  await env.DB.exec(SCHEMA);
  ready = true;
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const all = async (env, sql, params = []) => (await env.DB.prepare(sql).bind(...params).all()).results;
const run = (env, sql, params = []) => env.DB.prepare(sql).bind(...params).run();

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    await ensure(env);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    try {
      // ── What the new-tab page and the address bar are made of ──
      if (url.pathname === "/api/start") {
        const [bookmarks, recent, top, settings] = await Promise.all([
          all(env, "SELECT url, title FROM app_browser_bookmarks ORDER BY created_at DESC LIMIT 100"),
          all(env, "SELECT url, title, max(visited_at) AS visited_at FROM app_browser_visits GROUP BY url ORDER BY visited_at DESC LIMIT 40"),
          all(env, "SELECT url, title, count(*) AS visits FROM app_browser_visits GROUP BY url ORDER BY visits DESC, max(visited_at) DESC LIMIT 12"),
          all(env, "SELECT key, value FROM app_browser_settings"),
        ]);
        return json({ bookmarks, recent, top, settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) });
      }

      // ── Address-bar completion: bookmarks first, then what was visited most ──
      if (url.pathname === "/api/suggest") {
        const q = `%${String(url.searchParams.get("q") || "").toLowerCase()}%`;
        const rows = await all(env,
          `SELECT url, title, 1 AS bookmark, 0 AS visits FROM app_browser_bookmarks WHERE lower(url) LIKE ? OR lower(title) LIKE ?
           UNION ALL
           SELECT url, title, 0 AS bookmark, count(*) AS visits FROM app_browser_visits WHERE lower(url) LIKE ? OR lower(title) LIKE ?
             GROUP BY url
           ORDER BY bookmark DESC, visits DESC LIMIT 8`, [q, q, q, q]);
        const seen = new Set();
        return json({ items: rows.filter((r) => !seen.has(r.url) && seen.add(r.url)) });
      }

      if (url.pathname === "/api/visit" && req.method === "POST") {
        const href = String(body.url || "");
        if (!/^https?:/i.test(href)) return json({ ok: true });
        await run(env, "INSERT INTO app_browser_visits (url, title) VALUES (?, ?)", [href, String(body.title || "").slice(0, 300)]);
        return json({ ok: true });
      }

      if (url.pathname === "/api/history") {
        return json({ items: await all(env, "SELECT id, url, title, visited_at FROM app_browser_visits ORDER BY visited_at DESC LIMIT 300") });
      }
      if (url.pathname === "/api/history/clear" && req.method === "POST") {
        await run(env, body.url ? "DELETE FROM app_browser_visits WHERE url = ?" : "DELETE FROM app_browser_visits", body.url ? [String(body.url)] : []);
        return json({ ok: true });
      }

      if (url.pathname === "/api/bookmark" && req.method === "POST") {
        const href = String(body.url || "");
        if (!/^https?:/i.test(href)) return json({ ok: false, error: "Only http(s) pages can be bookmarked" }, 400);
        if (body.remove) await run(env, "DELETE FROM app_browser_bookmarks WHERE url = ?", [href]);
        else await run(env, "INSERT INTO app_browser_bookmarks (url, title) VALUES (?, ?) ON CONFLICT (url) DO UPDATE SET title = excluded.title", [href, String(body.title || "").slice(0, 300)]);
        return json({ ok: true, bookmarks: await all(env, "SELECT url, title FROM app_browser_bookmarks ORDER BY created_at DESC LIMIT 100") });
      }

      if (url.pathname === "/api/settings" && req.method === "POST") {
        for (const [key, value] of Object.entries(body || {})) {
          await run(env, "INSERT INTO app_browser_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [String(key), String(value)]);
        }
        return json({ ok: true });
      }

      // ── The AI reads whatever page is open: the frontend brings the text, this asks the question ──
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const question = String(body.question || "").trim();
        const page = String(body.text || "").slice(0, 60_000);
        const out = await env.AI.ask({
          summary: `browser: ${question.slice(0, 32) || "summarize"}`,
          system: "You answer questions about the web page the user is reading. Work only from the page text supplied; if the answer is not there, say so plainly. Be concise and specific. Reply in the language the user asks in.",
          prompt: `${question || "Summarize this page in a short paragraph, then list its key points."}\n\nPage: ${String(body.title || "")}\nURL: ${String(body.url || "")}\n\n---\n${page}`,
        });
        return out.ok ? json({ ok: true, text: out.text }) : json({ ok: false, error: out.error }, 502);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
