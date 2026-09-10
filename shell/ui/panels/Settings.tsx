import { useEffect, useState } from "react";
import { api, post } from "../lib/http";
import { t } from "../lib/i18n";
import { on, EV } from "../lib/realtime";
import "./Settings.css";

// Settings — a shell panel, not an app.
// It configures the framework itself: where conversations get their model from, and the system prompt.
// "Whatever configures the framework belongs to the shell, whatever does work is always an app" — that line stays firm.
//
// Model source is a two-way choice. Two connection sets live side by side in the kernel and never overwrite each other:
//   · Wandesk account — signing in mints the gateway connection; the card shows only balance and top-up.
//   · Custom gateway  — the user's own endpoint; the card shows the three fields.
// Picking a card switches `source` immediately; the set that is not selected stays stored.

type Source = "wandesk" | "custom";
type Account = { signedIn: boolean; source: Source; email?: string; credits?: number | null; rechargeUrl?: string; revoked?: boolean };
type Custom = { apiUrl: string; apiKey: string; model: string };

const isComplete = (c: Custom) => Boolean(c.apiUrl.trim() && c.apiKey.trim() && c.model.trim());

export function Settings() {
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<Source>("wandesk");
  const [custom, setCustom] = useState<Custom>({ apiUrl: "", apiKey: "", model: "" });
  const [savedCustom, setSavedCustom] = useState<Custom>({ apiUrl: "", apiKey: "", model: "" });
  const [system, setSystem] = useState("");
  const [savedSystem, setSavedSystem] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [flash, setFlash] = useState<"custom" | "system" | "">("");

  const loadSettings = () =>
    api<{ settings?: Record<string, string>; source?: Source }>("/api/settings").then((j) => {
      const s = j.settings || {};
      const c = { apiUrl: s.apiUrl || "", apiKey: s.apiKey || "", model: s.model || "" }; // apiKey comes back as a ******** placeholder
      setCustom(c); setSavedCustom(c);
      setSystem(s.system || ""); setSavedSystem(s.system || "");
      setSource(j.source === "custom" ? "custom" : "wandesk");
      setLoading(false);
    });
  const loadAccount = () => api<Account>("/api/account").then(setAccount).catch(() => setAccount({ signedIn: false, source }));

  useEffect(() => { void loadSettings(); void loadAccount(); }, []);
  // Sign-in completes in the browser; the kernel reports it over realtime and the panel refreshes itself.
  useEffect(() => on(EV.ACCOUNT_CHANGED, () => { setWaiting(false); void loadSettings(); void loadAccount(); }), []);

  const pick = async (next: Source) => {
    if (next === source) return;
    setSource(next);
    await post("/api/settings", { source: next });
    void loadAccount();
  };

  const signIn = async () => {
    setAccountError("");
    try {
      const r = await post<{ url?: string; error?: string }>("/api/account/login/start", {});
      if (!r.url) { setAccountError(t("settings.account.err", { e: r.error || "" })); return; }
      setWaiting(true);
      window.open(r.url, "_blank", "noopener");
    } catch (e: any) {
      setAccountError(t("settings.account.err", { e: String(e?.message || e) }));
    }
  };
  const signOut = async () => { await post("/api/account/logout", {}); };

  const saveCustom = async () => {
    const driver = /chat\/completions/i.test(custom.apiUrl) ? "chat" : "responses";
    await post("/api/settings", { driver, apiUrl: custom.apiUrl.trim(), apiKey: custom.apiKey, model: custom.model.trim(), source: "custom" });
    setSavedCustom(custom); setSource("custom");
    setFlash("custom"); window.setTimeout(() => setFlash(""), 2000);
  };
  const saveSystem = async () => {
    await post("/api/settings", { system });
    setSavedSystem(system);
    setFlash("system"); window.setTimeout(() => setFlash(""), 2000);
  };

  const customDirty = custom.apiUrl !== savedCustom.apiUrl || custom.apiKey !== savedCustom.apiKey || custom.model !== savedCustom.model;
  const wandeskActive = source === "wandesk" && !!account?.signedIn;
  const customActive = source === "custom" && isComplete(savedCustom);

  const field = (key: keyof Custom, label: string, type = "text", placeholder?: string) => (
    <label className="set-row">
      <span className="set-label">{label}</span>
      <input
        className="set-input"
        type={type}
        value={custom[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setCustom((c) => ({ ...c, [key]: e.target.value }))}
      />
    </label>
  );

  if (loading) return <div className="set-wrap"><p className="set-hint">{t("settings.loading")}</p></div>;

  return (
    <div className="set-wrap">
      <h2 className="set-title">{t("settings.source")}</h2>
      <p className="set-hint">{t("settings.source.hint")}</p>

      {/* ── Wandesk account ── */}
      <div className={`set-card${source === "wandesk" ? " is-on" : ""}`} onClick={() => void pick("wandesk")}>
        <div className="set-card-head">
          <span className="set-radio" aria-hidden="true" />
          <span className="set-card-title">{t("settings.source.wandesk")}</span>
          {wandeskActive && <span className="set-badge">{t("settings.source.active")}</span>}
        </div>
        <p className="set-card-desc">{t("settings.source.wandesk.desc")}</p>
        {source === "wandesk" && (
          <div className="set-card-body" onClick={(e) => e.stopPropagation()}>
            {account?.signedIn ? (
              <>
                <div className="set-account-who">{t("settings.account.signedIn", { email: account.email || "" })}</div>
                <div className="set-account-credits">
                  {account.credits == null ? t("settings.account.creditsUnknown") : t("settings.account.credits", { n: account.credits.toLocaleString() })}
                </div>
                <div className="set-account-actions">
                  <button className="set-save" onClick={() => window.open(account.rechargeUrl || "https://wandesk.ai/dashboard", "_blank", "noopener")}>{t("settings.account.topUp")}</button>
                  <button className="set-btn" onClick={signOut}>{t("settings.account.signOut")}</button>
                </div>
              </>
            ) : (
              <>
                {account?.revoked && <div className="set-account-warn">{t("settings.account.revoked")}</div>}
                <div className="set-account-actions">
                  <button className="set-save" onClick={signIn} disabled={waiting}>{t("settings.account.signIn")}</button>
                  {waiting && <span className="set-hint set-inline">{t("settings.account.waiting")}</span>}
                </div>
                {accountError && <div className="set-account-warn">{accountError}</div>}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Custom gateway ── */}
      <div className={`set-card${source === "custom" ? " is-on" : ""}`} onClick={() => void pick("custom")}>
        <div className="set-card-head">
          <span className="set-radio" aria-hidden="true" />
          <span className="set-card-title">{t("settings.source.custom")}</span>
          {customActive && <span className="set-badge">{t("settings.source.active")}</span>}
        </div>
        <p className="set-card-desc">{t("settings.source.custom.desc")}</p>
        {source === "custom" && (
          <div className="set-card-body" onClick={(e) => e.stopPropagation()}>
            {field("apiUrl", t("settings.apiUrl"), "text", "https://api.openai.com/v1/responses")}
            {field("apiKey", t("settings.apiKey"), "password")}
            {field("model", t("settings.model"), "text", "gpt-5.5")}
            <p className="set-card-note">{t("settings.source.custom.note")}</p>
            <div className="set-actions set-actions-end">
              {flash === "custom" && <span className="set-ok">{t("settings.saved")}</span>}
              <button className="set-save" onClick={saveCustom} disabled={!customDirty || !isComplete(custom)}>{t("settings.save")}</button>
            </div>
          </div>
        )}
      </div>

      {/* ── System prompt ── */}
      <h2 className="set-title set-title-gap">{t("settings.system")}</h2>
      <p className="set-hint">{t("settings.system.hint")}</p>
      <textarea
        className="set-input set-textarea"
        rows={5}
        value={system}
        onChange={(e) => setSystem(e.target.value)}
      />
      <div className="set-actions">
        <button className="set-save" onClick={saveSystem} disabled={system === savedSystem}>{t("settings.save")}</button>
        {flash === "system" && <span className="set-ok">{t("settings.saved")}</span>}
      </div>
    </div>
  );
}
