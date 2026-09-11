// Store — the app store's client. Catalog reads go to wandesk.ai through env.APPS.store; everything that
// touches this workspace (installed list, install, remove, publish) is a kernel syscall on env.APPS.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/catalog") {
        const q = url.searchParams.get("q") || "";
        return json(await env.APPS.store(`/api/store/apps${q ? `?q=${encodeURIComponent(q)}` : ""}`));
      }
      const m = /^\/api\/catalog\/([a-z0-9-]+)$/.exec(url.pathname);
      if (m) return json(await env.APPS.store(`/api/store/apps/${m[1]}`));
      if (url.pathname === "/api/mine") return json(await env.APPS.store("/api/store/mine"));
      if (url.pathname === "/api/pending") return json(await env.APPS.store("/api/store/pending"));
      if (url.pathname === "/api/installed") return json(await env.APPS.installed());
      if (url.pathname === "/api/install" && req.method === "POST") {
        const { id, version, force } = await req.json();
        return json(await env.APPS.install(String(id || ""), String(version || ""), { force: Boolean(force) }));
      }
      if (url.pathname === "/api/remove" && req.method === "POST") {
        const { id } = await req.json();
        return json(await env.APPS.remove(String(id || "")));
      }
      if (url.pathname === "/api/publish" && req.method === "POST") {
        const { id, notes } = await req.json();
        return json(await env.APPS.publish(String(id || ""), String(notes || "")));
      }
      if (url.pathname === "/api/review" && req.method === "POST") {
        const { id, status } = await req.json();
        return json(await env.APPS.store("/api/store/review", { id: String(id || ""), status: String(status || "") }));
      }
      if (url.pathname === "/api/open" && req.method === "POST") {
        const { id } = await req.json();
        await env.UI.openApp(String(id || ""), "/");
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
