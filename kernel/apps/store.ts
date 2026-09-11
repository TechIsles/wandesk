// App Store on the kernel side: pack / install / update / remove / publish app directories.
//
// A package is one app directory as a .tgz — everything but node_modules and data.db — so it carries app.json,
// APP.md, server.js, public/ (built, runs as-is) and src/ (edit and rebuild). Installing = the directory lands in
// apps/<id>/ and the watcher puts it on the desktop; removing = the directory goes. The upgrade rule is the same
// one preinstalled apps follow: a fingerprint is stamped at install, and an update is refused when the app was
// modified since (the user's app now), unless forced.
//
// tar comes from the OS (bsdtar on macOS and Windows 10+, GNU tar on Linux).
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { appsDir, kernelDir } from "../paths.js";
import { readSettings } from "../data/settings.js";
import { WANDESK_SITE } from "../config.js";
import { listApps } from "./scan.js";

const APP_ID = /^[a-z0-9][a-z0-9-]{2,31}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const STAMP = () => path.join(kernelDir(), "installed.json");
const SKIP = /^data\.db$/;
const SKIP_DIR = /^(node_modules|public)$/;

/** Same fingerprint as preinstall: content of everything except data.db, node_modules/ and public/. */
const fingerprint = (dir: string): string => {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.test(entry.name)) continue;
      if (entry.isDirectory() && !rel && SKIP_DIR.test(entry.name)) continue;
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(next);
      else { hash.update(next); hash.update(fs.readFileSync(path.join(dir, next))); }
    }
  };
  try { walk(""); } catch { return ""; }
  return hash.digest("hex").slice(0, 16);
};

type Stamp = Record<string, { version: string; fingerprint: string }>;
const readStamp = (): Stamp => { try { return JSON.parse(fs.readFileSync(STAMP(), "utf8")); } catch { return {}; } };
const writeStamp = (s: Stamp) => fs.writeFileSync(STAMP(), JSON.stringify(s, null, 2));

const readManifest = (dir: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
const assertId = (id: string) => { if (!APP_ID.test(id)) throw new Error(`invalid app id: ${id}`); return id; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wandesk-store-"));

/** The store is for signed-in desktops: every request carries the account's gateway key, the identity the AI gateway uses. */
const authHeaders = (): Record<string, string> => {
  const key = readSettings().gatewayKey || "";
  return key ? { authorization: `Bearer ${key}` } : {};
};
const errorOf = async (res: Response, fallback: string) => {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return String(data.error || fallback);
};

/** Installed apps with their version, author and whether the user changed them since install. */
export const installedApps = () => {
  const stamp = readStamp();
  return listApps().map((a) => {
    const s = stamp[a.id];
    return { id: a.id, name: a.name, icon: a.icon, version: a.version, author: a.author, hasSource: fs.existsSync(path.join(a.dir, "src")),
      installedVersion: s?.version || "", modified: s ? s.fingerprint !== fingerprint(a.dir) : false };
  });
};

/** apps/<id>/ → .tgz (without node_modules and data.db). Returns the archive path in a temp directory. */
export const packApp = (id: string): { file: string; manifest: Record<string, any>; readme: string; hasSource: boolean } => {
  assertId(id);
  const dir = path.join(appsDir(), id);
  if (!fs.existsSync(path.join(dir, "app.json"))) throw new Error(`app not found: ${id}`);
  const manifest = readManifest(dir);
  for (const k of ["id", "name", "icon", "description", "version", "author"]) {
    if (!manifest[k]) throw new Error(`app.json is missing "${k}" — fill it in before publishing`);
  }
  if (manifest.id !== id) throw new Error(`app.json id "${manifest.id}" does not match the directory "${id}"`);
  if (!SEMVER.test(String(manifest.version))) throw new Error(`version must be semver (x.y.z), got "${manifest.version}"`);
  const hasPackageJson = fs.existsSync(path.join(dir, "package.json"));
  const hasSource = fs.existsSync(path.join(dir, "src"));
  if (hasPackageJson && !hasSource) throw new Error("an app with package.json must ship its src/ so others can modify it");
  const file = path.join(tmp(), `${id}-${manifest.version}.tgz`);
  execFileSync("tar", ["-czf", file, "--exclude", "node_modules", "--exclude", "data.db", "--exclude", ".DS_Store", "-C", dir, "."], { stdio: "pipe" });
  let readme = "";
  try { readme = fs.readFileSync(path.join(dir, "APP.md"), "utf8"); } catch { /* optional */ }
  return { file, manifest, readme, hasSource };
};

/** Download a package and put it in place. `force` overwrites an app the user modified. */
export const installApp = async (id: string, version: string, opts: { force?: boolean } = {}) => {
  assertId(id);
  if (!SEMVER.test(version)) throw new Error(`invalid version: ${version}`);
  const target = path.join(appsDir(), id);
  const stamp = readStamp();
  if (fs.existsSync(target) && !opts.force) {
    const s = stamp[id];
    const modified = s ? s.fingerprint !== fingerprint(target) : true; // no stamp = we did not put it there = the user's app
    if (modified) return { installed: false as const, modified: true as const, message: `apps/${id} was modified locally; updating would overwrite your changes` };
  }

  const res = await fetch(`${WANDESK_SITE}/api/store/apps/${id}/versions/${version}/package`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await errorOf(res, `download failed: HTTP ${res.status}`));
  const work = tmp();
  const archive = path.join(work, "pkg.tgz");
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const unpacked = path.join(work, "app");
  fs.mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", archive, "-C", unpacked], { stdio: "pipe" });
  const manifest = readManifest(unpacked);
  if (manifest.id !== id) throw new Error(`package id "${manifest.id}" does not match "${id}"`);
  if (!fs.existsSync(path.join(unpacked, "server.js"))) throw new Error("package has no server.js");

  // Replace code and assets; keep the data.db link and any node_modules the user installed
  if (fs.existsSync(target)) {
    for (const name of fs.readdirSync(target)) {
      if (SKIP.test(name) || name === "node_modules") continue;
      fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(target, { recursive: true });
  }
  for (const name of fs.readdirSync(unpacked)) fs.cpSync(path.join(unpacked, name), path.join(target, name), { recursive: true });
  fs.rmSync(work, { recursive: true, force: true });

  stamp[id] = { version: String(manifest.version || version), fingerprint: fingerprint(target) };
  writeStamp(stamp);
  return { installed: true as const, modified: false as const, id, version: stamp[id].version };
};

/** Remove the directory. The app's database stays in .wandesk/store/, as the contract says. */
export const removeApp = (id: string) => {
  assertId(id);
  const target = path.join(appsDir(), id);
  if (!fs.existsSync(target)) return { removed: false as const };
  fs.rmSync(target, { recursive: true, force: true });
  const stamp = readStamp();
  delete stamp[id];
  writeStamp(stamp);
  return { removed: true as const };
};

/** Pack apps/<id>/ and send it to the store under the signed-in account. */
export const publishApp = async (id: string, notes = "") => {
  const { file, manifest, readme, hasSource } = packApp(id);
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("readme", readme);
  form.set("notes", String(notes || "").slice(0, 2000));
  form.set("has_source", hasSource ? "1" : "0");
  form.set("package", new Blob([fs.readFileSync(file)], { type: "application/gzip" }), path.basename(file));
  const res = await fetch(`${WANDESK_SITE}/api/store/publish`, { method: "POST", headers: authHeaders(), body: form });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  if (!res.ok) throw new Error(await errorOf(res, `publish failed: HTTP ${res.status}`));
  const body = (await res.json()) as Record<string, unknown>;
  // Publishing our own copy: stamp it so a later "update" from the store recognises it as untouched
  const stamp = readStamp();
  stamp[id] = { version: String(manifest.version), fingerprint: fingerprint(path.join(appsDir(), id)) };
  writeStamp(stamp);
  return body;
};

/** The store API: GET, or POST when a body is given. */
export const storeFetch = async (pathname: string, body?: unknown) => {
  const headers = authHeaders();
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${WANDESK_SITE}${pathname}`, { method: body !== undefined ? "POST" : "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(await errorOf(res, `store request failed: HTTP ${res.status}`));
  return (await res.json()) as Record<string, unknown>;
};
