// Settings: model connection + system prompt + shell preferences. A single KV table, values are always strings.
import { all, run } from "./db.js";

export type Settings = Record<string, string>;

export const readSettings = (): Settings => {
  const out: Settings = {};
  for (const row of all<{ key: string; value: string }>("SELECT key, value FROM settings")) out[row.key] = row.value;
  return out;
};

export const writeSettings = (patch: Settings) => {
  for (const [key, value] of Object.entries(patch)) {
    run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value ?? ""));
  }
};

/** Read a snapshot once when an agent turn starts — changing settings mid-turn doesn't affect the turn already running. */
export type ModelConfig = {
  driver: string;
  url: string;
  apiKey: string;
  model: string;
  system: string;
};

/** Where conversations get their model from. Two sets are stored side by side and never overwrite each other:
 *  `wandesk` = the gateway connection minted at sign-in (gatewayUrl / gatewayKey / gatewayModel);
 *  `custom`  = the user's own endpoint (driver / apiUrl / apiKey / model). Default is the Wandesk account. */
export type ModelSource = "wandesk" | "custom";
export const modelSource = (s: Settings = readSettings()): ModelSource => (s.source === "custom" ? "custom" : "wandesk");

export const gatewayConfig = (s: Settings = readSettings()) => ({
  driver: "responses", url: s.gatewayUrl || "", apiKey: s.gatewayKey || "", model: s.gatewayModel || "",
});
export const customConfig = (s: Settings = readSettings()) => ({
  driver: s.driver || "responses", url: s.apiUrl || "", apiKey: s.apiKey || "", model: s.model || "",
});
const complete = (c: { url: string; apiKey: string; model: string }) => Boolean(c.url && c.apiKey && c.model);

export const modelConfig = (): ModelConfig => {
  const s = readSettings();
  const c = modelSource(s) === "wandesk" ? gatewayConfig(s) : customConfig(s);
  return { ...c, system: s.system || "" };
};

/** True when the selected source can actually answer. */
export const isConnected = (s: Settings = readSettings()) =>
  complete(modelSource(s) === "wandesk" ? gatewayConfig(s) : customConfig(s));

/** UI language: read from the settings table (key "language"); defaults to "en" for anything else. */
export type Language = "zh" | "en";

export const currentLanguage = (): Language => {
  const saved = readSettings().language;
  return saved === "zh" || saved === "en" ? saved : "en";
};
