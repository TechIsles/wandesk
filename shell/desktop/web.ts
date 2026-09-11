// A real browser surface for apps: every tab is an Electron WebContentsView — a full Chromium page
// with its own cookies, storage, downloads and DevTools. Not an iframe, so X-Frame-Options and CSP
// don't apply and any site loads.
//
// A view is a sibling of the window's web page, never part of it: it paints above everything the
// renderer draws. The shell therefore tells us, frame by frame, the exact rectangle the app's
// placeholder occupies, and detaches the view the moment anything covers it (another window, a menu,
// the app's own overlay) — see shell/ui/appframe/web.ts. Every hide carries a fresh snapshot back so
// the app can paint a still in the same place and the seam is invisible.
//
// The kernel knows nothing about any of this: it is the shell's own capability, reached from an app
// through window.wandesk.web (postMessage → AppFrame → preload → here).
import { BrowserWindow, Menu, WebContentsView, clipboard, session, shell } from "electron";

export type Rect = { x: number; y: number; w: number; h: number };
type Event = { id: number; kind: string; [k: string]: unknown };

const PARTITION = "persist:web"; // one profile shared by every tab, as a browser does
const views = new Map<number, WebContentsView>();
const shown = new Set<number>();
const wanted = new Map<number, Rect | null>(); // what the shell last asked for, per page
const hiding = new Set<number>();             // a snapshot is in flight for these
let host: BrowserWindow | null = null;
let send: (event: Event) => void = () => {};
let seq = 0;

const int = (n: number) => Math.round(Number.isFinite(n) ? n : 0);
const get = (id: number) => {
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) throw new Error(`No such page: ${id}`);
  return view;
};

/** Sites get a plain Chrome user agent: "Electron" in the string is what breaks logins and feature detection. */
const userAgent = () =>
  `Mozilla/5.0 (${process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64"}) ` +
  `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;

export const attachWeb = (window: BrowserWindow, emit: (event: Event) => void) => {
  host = window;
  send = emit;
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(userAgent());
  ses.on("will-download", (_e, item) => {
    const name = item.getFilename();
    send({ id: 0, kind: "download", name, state: "started" });
    item.once("done", (_ev, state) => send({ id: 0, kind: "download", name, state, path: item.getSavePath() }));
  });
  window.on("closed", () => { for (const id of [...views.keys()]) destroy(id); host = null; });
};

/** Everything the app needs to draw its chrome, sent on every change. */
const state = (id: number) => {
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  send({ id, kind: "state", url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() });
};

const contextMenu = (id: number, params: Electron.ContextMenuParams) => {
  const wc = get(id).webContents;
  const item = (label: string, click: () => void, enabled = true) => ({ label, click, enabled });
  const template: Electron.MenuItemConstructorOptions[] = [];
  if (params.linkURL) {
    template.push(
      item("Open Link in New Tab", () => send({ id, kind: "popup", url: params.linkURL })),
      item("Copy Link", () => clipboard.writeText(params.linkURL)),
      item("Open Link in System Browser", () => void shell.openExternal(params.linkURL)),
      { type: "separator" },
    );
  }
  if (params.mediaType === "image" && params.srcURL) {
    template.push(item("Copy Image Address", () => clipboard.writeText(params.srcURL)), { type: "separator" });
  }
  if (params.isEditable) {
    template.push(
      item("Cut", () => wc.cut(), params.editFlags.canCut),
      item("Copy", () => wc.copy(), params.editFlags.canCopy),
      item("Paste", () => wc.paste(), params.editFlags.canPaste),
      item("Select All", () => wc.selectAll()),
      { type: "separator" },
    );
  } else if (params.selectionText) {
    template.push(item("Copy", () => wc.copy()), { type: "separator" });
  }
  template.push(
    item("Back", () => wc.navigationHistory.goBack(), wc.navigationHistory.canGoBack()),
    item("Forward", () => wc.navigationHistory.goForward(), wc.navigationHistory.canGoForward()),
    item("Reload", () => wc.reload()),
    { type: "separator" },
    item("Inspect Element", () => wc.inspectElement(params.x, params.y)),
  );
  Menu.buildFromTemplate(template).popup({ window: host ?? undefined });
};

/** Shortcuts belong to the app's chrome, but the keystroke lands in the page — hand it back. */
const KEYS: Record<string, string> = { l: "address", t: "newTab", w: "closeTab", r: "reload", f: "find", "[": "back", "]": "forward" };

export const create = (url: string): number => {
  if (!host) throw new Error("The shell window is not ready");
  const id = ++seq;
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } });
  const wc = view.webContents;
  views.set(id, view);

  for (const ev of ["page-title-updated", "did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "did-finish-load"] as const) {
    wc.on(ev as any, () => state(id));
  }
  wc.on("page-favicon-updated", (_e, icons) => send({ id, kind: "favicon", url: icons[0] || "" }));
  wc.on("did-fail-load", (_e, code, description, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) send({ id, kind: "failed", code, description, url: failedUrl }); // -3 = aborted by a new navigation
    state(id);
  });
  wc.on("found-in-page", (_e, result) => send({ id, kind: "found", active: result.activeMatchOrdinal, total: result.matches }));
  wc.on("context-menu", (_e, params) => contextMenu(id, params));
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    const action = mod && !input.alt ? KEYS[input.key.toLowerCase()] : input.key === "Escape" ? "escape" : "";
    if (!action) return;
    event.preventDefault();
    send({ id, kind: "key", action });
  });
  // A target=_blank or window.open becomes a new tab in the app, never a stray OS window
  wc.setWindowOpenHandler(({ url: next }) => { send({ id, kind: "popup", url: next }); return { action: "deny" }; });

  void wc.loadURL(url).catch(() => {});
  return id;
};

export const destroy = (id: number) => {
  const view = views.get(id);
  if (!view) return;
  if (shown.has(id)) { host?.contentView.removeChildView(view); shown.delete(id); }
  wanted.delete(id);
  hiding.delete(id);
  views.delete(id);
  try { view.webContents.close(); } catch { /* already gone */ }
};

/** The one call the shell makes every frame: where the page goes, or null when something covers it.
 *  Synchronous on purpose — the snapshot that goes with a hide is taken while the page is still on
 *  screen, and by the time it comes back the answer may have changed, so what the shell last asked for
 *  is kept in `wanted` and checked again before anything is actually detached. */
export const place = (id: number, rect: Rect | null) => {
  const view = views.get(id);
  if (!view || !host || view.webContents.isDestroyed()) return;
  const next = !rect || rect.w < 2 || rect.h < 2 ? null : rect;
  wanted.set(id, next);

  if (next) {
    view.setBounds({ x: int(next.x), y: int(next.y), width: int(next.w), height: int(next.h) });
    if (!shown.has(id)) { host.contentView.addChildView(view); shown.add(id); state(id); }
    return;
  }
  if (!shown.has(id) || hiding.has(id)) return;
  hiding.add(id);
  void capture(id).catch(() => "").then((snapshot) => {
    hiding.delete(id);
    // Shown again while the snapshot was being taken, or gone entirely: leave it alone
    if (wanted.get(id) !== null || !shown.has(id) || !host || !views.has(id)) return;
    host.contentView.removeChildView(view);
    shown.delete(id);
    if (snapshot) send({ id, kind: "snapshot", data: snapshot });
  });
};

const capture = async (id: number) => {
  const image = await get(id).webContents.capturePage();
  return image.isEmpty() ? "" : image.toDataURL();
};

/** Everything else an app asks of a page. One entry point so the preload stays a thin pipe. */
export const call = async (id: number, method: string, args: any[] = []): Promise<unknown> => {
  const wc = get(id).webContents;
  switch (method) {
    case "navigate": {
      const url = String(args[0] || "");
      await wc.loadURL(url).catch(() => {}); // a failed load reports itself through did-fail-load
      return { ok: true };
    }
    case "back": if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return { ok: true };
    case "forward": if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return { ok: true };
    case "reload": args[0] ? wc.reloadIgnoringCache() : wc.reload(); return { ok: true };
    case "stop": wc.stop(); return { ok: true };
    case "zoom": wc.setZoomFactor(Math.max(0.25, Math.min(5, Number(args[0]) || 1))); return { factor: wc.getZoomFactor() };
    case "find": wc.findInPage(String(args[0] || ""), { forward: args[1] !== false, findNext: Boolean(args[2]) }); return { ok: true };
    case "stopFind": wc.stopFindInPage("clearSelection"); return { ok: true };
    case "devtools": wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" }); return { ok: true };
    case "print": await wc.print({}); return { ok: true };
    case "text": return { text: await wc.executeJavaScript("document.body ? document.body.innerText : ''", true) };
    case "html": return { html: await wc.executeJavaScript("document.documentElement.outerHTML", true) };
    case "execute": return { result: await wc.executeJavaScript(String(args[0] || ""), true) };
    case "capture": return { data: await capture(id) };
    case "state": state(id); return { ok: true };
    default: throw new Error(`Unknown page method: ${method}`);
  }
};
