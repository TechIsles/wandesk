// Tasks — the kernel's task record (every env.AI call) and the conversations that are running right now. Read-only.
// Tasks are product data and only ever reach an app through env.AI; this app never touches raw tables.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/tasks") {
        const limit = Number(url.searchParams.get("limit")) || 200;
        return json(await env.AI.tasks({ limit }));
      }
      const m = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
      if (m) return json(await env.AI.tasks({ id: Number(m[1]) }));
      if (url.pathname === "/api/runs") {
        // Conversation surface: running ids + the conversation list, joined here so the frontend gets titles
        const [runs, list] = await Promise.all([
          env.AI.fetch(new Request("http://x/api/runs")).then((r) => r.json()).catch(() => ({ ids: [] })),
          env.AI.fetch(new Request("http://x/api/conversations")).then((r) => r.json()).catch(() => ({ conversations: [] })),
        ]);
        const ids = new Set(runs.ids || []);
        const all = Array.isArray(list) ? list : list.conversations || [];
        return json({ conversations: all.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, title: c.title })) });
      }
      if (url.pathname === "/api/open-assistant") {
        await env.UI.openApp("chat", "/");
        return json({ ok: true });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  },
};
