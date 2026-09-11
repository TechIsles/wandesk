// Store — the app store's client. Everything about the catalog (apps, versions, reviews, publishing state) is on
// wandesk.ai and goes through env.APPS.store, which carries the signed-in account's key; everything that touches
// this workspace (installed list, install, remove, publish) is a kernel syscall on env.APPS.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const APP_ID = /^[a-z0-9][a-z0-9-]{2,31}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const id = String(body.id || "");
    try {
      // ── Account ──
      if (url.pathname === "/api/me") {
        try { return json({ signedIn: true, ...(await env.APPS.store("/api/store/me")) }); }
        catch (e) { return json({ signedIn: false, error: String(e?.message || e) }); }
      }
      if (url.pathname === "/api/settings" && req.method === "POST") {
        await env.UI.openApp("__settings", "/");
        return json({ ok: true });
      }

      // ── Catalog ──
      if (url.pathname === "/api/catalog") {
        const q = url.searchParams.get("q") || "";
        return json(await env.APPS.store(`/api/store/apps${q ? `?q=${encodeURIComponent(q)}` : ""}`));
      }
      const m = /^\/api\/catalog\/([a-z0-9-]+)$/.exec(url.pathname);
      if (m) return json(await env.APPS.store(`/api/store/apps/${m[1]}`));

      // ── This workspace ──
      if (url.pathname === "/api/installed") return json(await env.APPS.installed());
      if (url.pathname === "/api/install" && req.method === "POST") return json(await env.APPS.install(id, String(body.version || ""), { force: Boolean(body.force) }));
      if (url.pathname === "/api/remove" && req.method === "POST") return json(await env.APPS.remove(id));
      if (url.pathname === "/api/open" && req.method === "POST") {
        if (!APP_ID.test(id)) return json({ error: "Invalid app id" }, 400);
        await env.UI.openApp(id, "/");
        return json({ ok: true });
      }

      // ── Publishing ──
      if (url.pathname === "/api/mine") return json(await env.APPS.store("/api/store/mine"));
      if (url.pathname === "/api/publish" && req.method === "POST") return json(await env.APPS.publish(id, String(body.notes || "")));
      if (url.pathname === "/api/withdraw" && req.method === "POST") return json(await env.APPS.store("/api/store/withdraw", { id, version: String(body.version || "") }));
      if (url.pathname === "/api/listing" && req.method === "POST") return json(await env.APPS.store("/api/store/listing", { id, listed: Boolean(body.listed), note: String(body.note || "") }));

      // ── Review (admins) ──
      if (url.pathname === "/api/pending") return json(await env.APPS.store("/api/store/pending"));
      if (url.pathname === "/api/review" && req.method === "POST") {
        return json(await env.APPS.store("/api/store/review", { id, version: String(body.version || ""), status: String(body.status || ""), note: String(body.note || "") }));
      }

      // ── Ratings and reviews ──
      if (url.pathname === "/api/reviews" && req.method === "POST") return json(await env.APPS.store("/api/store/reviews", { id, rating: Number(body.rating), body: String(body.body || "") }));
      if (url.pathname === "/api/reviews/delete" && req.method === "POST") {
        return json(await env.APPS.store("/api/store/reviews/delete", body.user_id === undefined ? { id } : { id, user_id: Number(body.user_id) }));
      }
      if (url.pathname === "/api/reviews/reply" && req.method === "POST") return json(await env.APPS.store("/api/store/reviews/reply", { id, user_id: Number(body.user_id), reply: String(body.reply || "") }));

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
