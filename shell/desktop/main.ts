// Electron main process: one window, pointed at the local kernel.
//
// The shell's job here is nothing more than the "window" itself —— the desktop, icons, and
// taskbar all live in the web page, because they're the exact same code as the browser version.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { startKernel, stopKernel } from "./boot.js";
import { attachWeb, call, create, destroy, place } from "./web.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled output lives at dist/shell/desktop/ —— three levels up is the app root (Resources/app once packaged)
const HOME = path.join(__dirname, "../../..");

let win: BrowserWindow | null = null;

const createWindow = async () => {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    title: "Wandesk",
    // Use the system's default title bar: the traffic-light buttons and window title are both drawn by macOS
    backgroundColor: "#f6f6f7",
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") },
  });

  // The browser surface: apps ask for a real Chromium page through window.wandesk.web
  attachWeb(win, (event) => { if (win && !win.isDestroyed()) win.webContents.send("web.event", event); });

  // A target=_blank inside an app is handed off to the system browser instead of opening a new window in the shell
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  try {
    const origin = await startKernel(HOME);
    await win.loadURL(origin);
  } catch (e: any) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<body style="font:14px -apple-system;padding:40px;color:#444">Kernel failed to start: ${e?.message || e}</body>`,
    )}`);
  }
  win.on("closed", () => { win = null; });
};

ipcMain.handle("web.create", (_e, url: string) => create(String(url || "about:blank")));
ipcMain.handle("web.destroy", (_e, id: number) => { destroy(Number(id)); return true; });
ipcMain.handle("web.call", (_e, id: number, method: string, args: unknown[]) => call(Number(id), String(method), (args || []) as any[]));
ipcMain.on("web.place", (_e, id: number, rect) => place(Number(id), rect));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { stopKernel(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
app.on("before-quit", stopKernel);
