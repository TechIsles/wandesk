// Route dispatch. Matches only on prefix; the actual handling lives in each resource file —— index carries no business logic of its own.
import type { IncomingMessage, ServerResponse } from "http";
import { json } from "./http.js";
import { handleAppsApi } from "./apps.js";
import { handleAppApi } from "./app.js";
import { handleSettingsApi, handleSettingsTest } from "./settings.js";
import { handleAccountApi } from "./account.js";
import { handleWallpaperApi } from "./wallpaper.js";
import { convApi } from "../conv/index.js";
import { runtimeOrigin } from "../../runtime/supervisor.js";

export const handleApi = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
  const path = new URL(req.url || "/", "http://x").pathname;

  if (path === "/api/health") return json(res, 200, { ok: true, runtime: runtimeOrigin() });

  // Conversation surface: AGENT's web/server runs here as-is; apps reach it via env.AI.fetch().
  // The prefix is deliberately not /api/conv: the app-side paths already carry /api/, so nesting
  // under /api/ would produce a double prefix like /api/conv/api/meta. Stripping just /conv restores
  // exactly the /api/meta path it expects.
  if (path.startsWith("/conv/")) {
    const inner = new URL(req.url || "/", "http://x");
    inner.pathname = path.slice("/conv".length);
    return convApi()(req, res, inner);
  }

  // The execution endpoint for app syscalls (only ever looped back to by the HostGate inside workerd)
  if (path.startsWith("/api/app/")) return handleAppApi(req, res, path.slice("/api/app/".length));

  if (path.startsWith("/api/apps")) return handleAppsApi(req, res, path.slice("/api/apps".length));
  if (path === "/api/settings/test" && req.method === "POST") return handleSettingsTest(req, res);
  if (path === "/api/settings") return handleSettingsApi(req, res);
  if (path.startsWith("/api/account")) return handleAccountApi(req, res, path.slice("/api/account".length));
  if (path.startsWith("/api/wallpaper")) return handleWallpaperApi(req, res, path.slice("/api/wallpaper".length));

  return false;
};
