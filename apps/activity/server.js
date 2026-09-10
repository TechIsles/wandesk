// Activity — read-only view of the kernel's activity ledger and the running conversations.
// The ledger is product data and only ever reaches an app through env.AI; this app never touches raw tables.
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/activity") {
        const limit = Number(url.searchParams.get("limit")) || 200;
        return json(await env.AI.activity({ limit }));
      }
      if (url.pathname === "/api/runs") {
        // Conversation surface: running ids + the conversation list, joined here so the frontend gets titles
        const [runs, list] = await Promise.all([
          env.AI.fetch(new Request("http://x/api/runs")).then((r) => r.json()).catch(() => ({ ids: [] })),
          env.AI.fetch(new Request("http://x/api/conversations")).then((r) => r.json()).catch(() => ({ conversations: [] })),
        ]);
        const ids = new Set(runs.ids || []);
        const conversations = (list.conversations || list || []).filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, title: c.title }));
        return json({ conversations });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  },
};
