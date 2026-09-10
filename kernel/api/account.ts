// Wandesk account: sign in with Google on wandesk.ai and receive a gateway key, which becomes the model connection.
//
// Flow: the shell asks for a sign-in URL → the kernel opens a one-shot loopback server and hands back
// `<site>/api/auth/desktop/start?port=…&state=…` → the browser completes Google sign-in on the site → the site
// redirects to `http://127.0.0.1:<port>/callback?state=…&code=…` → the kernel redeems the one-time code over
// HTTPS for the gateway URL / key / model and writes them into settings. The key itself never travels in a URL.
import http from "http";
import os from "os";
import crypto from "crypto";
import type { AddressInfo } from "net";
import type { IncomingMessage, ServerResponse } from "http";
import { json, text } from "./http.js";
import { readSettings, writeSettings } from "../data/settings.js";
import { broadcast } from "../realtime.js";
import { EV } from "../shared/events.js";
import { WANDESK_SITE } from "../config.js";

const GATEWAY_PREFIX = `${WANDESK_SITE}/v1/`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

type Pending = { server: http.Server; state: string; timer: NodeJS.Timeout };
let pending: Pending | null = null;

const closePending = () => {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
};

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px/1.6 -apple-system,system-ui,sans-serif;color:#1d1d20;background:#f6f6f7;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="max-width:420px;padding:32px 36px;background:#fff;border:1px solid #d9dbe0;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.08)">` +
  `<h1 style="font-size:18px;margin:0 0 8px">${title}</h1><p style="margin:0;color:#4a5568">${body}</p></div>`;

/** Redeem the one-time code for the gateway connection and store it. */
const finishLogin = async (code: string) => {
  const r = await fetch(`${WANDESK_SITE}/api/auth/desktop/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const apiUrl = String(j.agent_api_url || "");
  const apiKey = String(j.agent_api_key || "");
  const model = String(j.agent_model || "");
  if (!r.ok || !j.success || !apiUrl || !apiKey || !model) {
    throw new Error(String(j.message || `exchange failed (${r.status})`));
  }
  const driver = /chat\/completions/i.test(apiUrl) ? "chat" : "responses";
  writeSettings({ driver, apiUrl, apiKey, model });
  const email = await fetchEmail(apiKey);
  writeSettings({ accountEmail: email });
  broadcast(EV.ACCOUNT_CHANGED, { signedIn: true, email });
};

const fetchEmail = async (apiKey: string): Promise<string> => {
  try {
    const r = await fetch(`${WANDESK_SITE}/v1/credits`, { headers: { authorization: `Bearer ${apiKey}` } });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return r.ok ? String(j.email || "") : "";
  } catch {
    return "";
  }
};

const handleCallback = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") { text(res, 404, "not found"); return; }
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  if (!pending || state !== pending.state || !code) {
    text(res, 400, page("Sign-in request not recognized", "Return to Wandesk and start the sign-in again."), "text/html; charset=utf-8");
    return;
  }
  try {
    await finishLogin(code);
    text(res, 200, page("Signed in", "Wandesk has been connected to your account. You can close this window and return to the app."), "text/html; charset=utf-8");
  } catch (e: any) {
    text(res, 500, page("Sign-in failed", String(e?.message || e)), "text/html; charset=utf-8");
  } finally {
    closePending();
  }
};

/** Open the loopback server and return the sign-in URL for the browser. */
const startLogin = async (): Promise<string> => {
  closePending();
  const state = crypto.randomBytes(16).toString("hex");
  const server = http.createServer((req, res) => { void handleCallback(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(closePending, LOGIN_TIMEOUT_MS);
  pending = { server, state, timer };

  const url = new URL("/api/auth/desktop/start", WANDESK_SITE);
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", state);
  url.searchParams.set("name", os.hostname());
  return url.toString();
};

/** Signed in = the model connection points at the Wandesk gateway. */
const account = async () => {
  const s = readSettings();
  if (!s.apiUrl?.startsWith(GATEWAY_PREFIX) || !s.apiKey) return { signedIn: false };
  try {
    const r = await fetch(`${WANDESK_SITE}/v1/credits`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 401) return { signedIn: false, revoked: true };
    if (!r.ok) throw new Error(String(r.status));
    return { signedIn: true, email: String(j.email || s.accountEmail || ""), credits: Number(j.credits ?? 0), rechargeUrl: String(j.recharge_url || `${WANDESK_SITE}/dashboard`) };
  } catch {
    return { signedIn: true, email: s.accountEmail || "", credits: null, rechargeUrl: `${WANDESK_SITE}/dashboard` };
  }
};

const logout = () => {
  writeSettings({ apiUrl: "", apiKey: "", model: "", accountEmail: "" });
  broadcast(EV.ACCOUNT_CHANGED, { signedIn: false });
};

export const handleAccountApi = async (req: IncomingMessage, res: ServerResponse, sub: string): Promise<boolean> => {
  if (sub === "" && req.method === "GET") return json(res, 200, await account());
  if (sub === "/login/start" && req.method === "POST") {
    try { return json(res, 200, { url: await startLogin() }); }
    catch (e: any) { return json(res, 500, { error: String(e?.message || e) }); }
  }
  if (sub === "/logout" && req.method === "POST") { logout(); return json(res, 200, { ok: true }); }
  return false;
};
