// Backend of this app: a Worker serving its own API and static assets. Frontend source lives in src/;
// after editing, run `npm install && npm run build` in this directory.
const SCHEMA = "-- Phone · the AI-generated screen log. Every screen the AI improvises is appended here,\n-- so reopening the phone resumes the latest screen. Powering off wipes the table for a fresh\n-- phone (and a fresh owner/world). The model is handed the current screen on every call, so\n-- this is only what is needed to put the last screen back on the LCD.\nCREATE TABLE IF NOT EXISTS app_phone_screens (\n  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n  content    TEXT NOT NULL,                       -- inline-styled HTML for the screen body\n  options    TEXT NOT NULL DEFAULT '[]',          -- JSON array of {text} follow-up choices\n  created_at TEXT NOT NULL DEFAULT (datetime('now'))\n);
";

let ready = false;
const ensure = async (env) => {
  if (ready) return;
  if (SCHEMA) await env.DB.exec(SCHEMA);
  ready = true;
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    try {
      // ── its own database (D1) ──
      if (url.pathname === "/api/db") {
        await ensure(env);
        const { sql, params } = await req.json();
        const stmt = env.DB.prepare(String(sql || ""));
        const r = await (Array.isArray(params) && params.length ? stmt.bind(...params) : stmt).all();
        return json({ ok: true, rows: r.results, changes: r.meta?.changes ?? 0, lastInsertRowid: r.meta?.last_row_id ?? 0 });
      }

      // ── the one intelligence surface ──
      if (url.pathname === "/api/agent") {
        const { prompt, data, system, schema } = await req.json();
        const want = schema
          ? "\n\nOutput only JSON matching the JSON Schema below — no code fences, no explanation:\n" + JSON.stringify(schema)
          : "";
        const out = await env.AI.ask({
          summary: `phone:` + String(prompt || "").slice(0, 24),
          system: String(system || ""),
          prompt: String(prompt || "") + want,
          data,
        });
        if (!out.ok) return json({ ok: false, error: out.error });
        let parsed;
        if (schema) {
          try { parsed = JSON.parse(String(out.text).trim().replace(/^\`\`\`[a-z]*\n?|\`\`\`$/g, "")); } catch { /* model didn't return valid JSON */ }
        }
        return json({ ok: true, result: out.text, json: parsed });
      }

      // ── outbound network: unrestricted, the backend fetches directly ──
      if (url.pathname === "/api/http") {
        const { url: target, method, headers, body } = await req.json();
        const res = await fetch(String(target), { method: method || "GET", headers, body });
        return json({ ok: res.ok, status: res.status, body: await res.text() });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) });
    }
  },
};
