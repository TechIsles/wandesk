// SDK for app frontends: <script src="/_wd/sdk.js">.
//
// Only needed when you have to touch the **shell itself** — an app talks to its own backend over the same origin,
// so `fetch("/api/…")` just works with no SDK required. What's provided here is what an app can't reach on its own:
// showing a toast, opening another app, getting instance info.
// It goes through postMessage to the parent window (an iframe is an opaque origin and can't reach the parent window's objects).
//
// Assembled fresh on every request: the current UI language (see currentLanguage() in data/settings.ts) is stuffed into
// window.wandesk.lang, and document.documentElement.lang is set to zh-CN / en.
// Callers (kernel/api/apps.ts, runtime/overseer.js) must send cache-control: no-store,
// otherwise after a language switch the app page can still get a stale cached SDK.
import { currentLanguage } from "../data/settings.js";

export const sdkSource = (): string => {
  const lang = currentLanguage();
  const htmlLang = lang === "en" ? "en" : "zh-CN";
  return `(() => {
  try { document.documentElement.lang = ${JSON.stringify(htmlLang)}; } catch {}
  const pending = new Map();
  let seq = 0;

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ __wandesk: true, id, method, params }, "*");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("Shell did not respond: " + method)); }
    }, 15000);
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || msg.__wandesk !== true) return;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
      return;
    }
    if (msg.event) for (const fn of (listeners.get(msg.event) || [])) { try { fn(msg.payload); } catch {} }
  });

  const listeners = new Map();

  window.wandesk = {
    /** Current UI language ("zh" | "en") — assembled fresh by the kernel on every request, never a stale cached value. */
    lang: ${JSON.stringify(lang)},
    /** This instance's context: appId, mount point, current route. */
    context: () => call("context", {}),
    ui: {
      toast: (text, kind) => call("toast", { text, kind }),
      confirm: (text) => call("confirm", { text }),
      title: (text) => call("title", { text }),
      openApp: (appId, route) => call("openApp", { appId, route }),
      openExternal: (url) => call("openExternal", { url }),
      copyText: (text) => call("copyText", { text }),
      close: () => call("close", {}),
    },
    /** A real browser page: full Chromium, its own cookies and storage, no iframe restrictions.
     *  open() returns { id }; place() hands the shell the rectangle inside this frame where the page
     *  may paint (null takes it off screen, and is what you do while an overlay of your own is open).
     *  The shell keeps that rectangle in step with the window and pulls the page whenever anything
     *  covers it, sending back a snapshot to paint in its place. Listen with wandesk.on("web", fn):
     *  { kind: "state" | "snapshot" | "favicon" | "found" | "failed" | "popup" | "key" | "download", id, … }. */
    web: {
      available: () => call("web.available", {}).then((r) => r.available),
      open: (url) => call("web.create", { url }),
      close: (id) => call("web.destroy", { id }),
      place: (id, rect) => call("web.place", { id, rect }),
      navigate: (id, url) => call("web.call", { id, method: "navigate", args: [url] }),
      back: (id) => call("web.call", { id, method: "back" }),
      forward: (id) => call("web.call", { id, method: "forward" }),
      reload: (id, hard) => call("web.call", { id, method: "reload", args: [Boolean(hard)] }),
      stop: (id) => call("web.call", { id, method: "stop" }),
      zoom: (id, factor) => call("web.call", { id, method: "zoom", args: [factor] }),
      find: (id, text, forward, next) => call("web.call", { id, method: "find", args: [text, forward, next] }),
      stopFind: (id) => call("web.call", { id, method: "stopFind" }),
      devtools: (id) => call("web.call", { id, method: "devtools" }),
      print: (id) => call("web.call", { id, method: "print" }),
      /** What the page says, for an app that wants to read or drive it. */
      text: (id) => call("web.call", { id, method: "text" }).then((r) => r.text),
      html: (id) => call("web.call", { id, method: "html" }).then((r) => r.html),
      execute: (id, code) => call("web.call", { id, method: "execute", args: [code] }).then((r) => r.result),
      capture: (id) => call("web.call", { id, method: "capture" }).then((r) => r.data),
      state: (id) => call("web.call", { id, method: "state" }),
    },
    /** Send messages between multiple instances of the same app (window ↔ sidebar panel). */
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    emit: (event, payload) => call("emit", { event, payload }),
  };
})();
`;
};
