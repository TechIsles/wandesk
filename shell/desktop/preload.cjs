// The shell page's only line to the Electron main process. Deliberately a pipe and nothing else:
// no logic, no policy, one namespace. Plain CommonJS because a sandboxed preload cannot be ESM.
//
// What it carries today is the browser surface (see shell/desktop/web.ts). Absent this bridge —— in a
// plain browser during development —— window.wandeskShell is simply undefined and apps fall back.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wandeskShell", {
  web: {
    create: (url) => ipcRenderer.invoke("web.create", url),
    destroy: (id) => ipcRenderer.invoke("web.destroy", id),
    /** Per-frame, fire and forget: a rectangle in window coordinates, or null when the page must not paint. */
    place: (id, rect) => ipcRenderer.send("web.place", id, rect),
    call: (id, method, args) => ipcRenderer.invoke("web.call", id, method, args),
    on: (fn) => {
      const handler = (_event, message) => fn(message);
      ipcRenderer.on("web.event", handler);
      return () => ipcRenderer.off("web.event", handler);
    },
  },
});
