// tsc only moves .ts/.js files. Everything else —— the kernel's table-creation script, the Electron
// preload (CommonJS on purpose, a sandboxed preload cannot be ESM) —— has to be copied over by hand.
import fs from "fs";
import path from "path";

const ASSETS = ["kernel/data/schema.sql", "shell/desktop/preload.cjs"];

for (const rel of ASSETS) {
  const to = path.join("dist", rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(rel, to);
  console.log(`[assets] ${rel} → ${to}`);
}
