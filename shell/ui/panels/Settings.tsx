import { useEffect, useState } from "react";
import { api, post } from "../lib/http";
import { t } from "../lib/i18n";
import { on, EV } from "../lib/realtime";
import "./Settings.css";

// Settings — a shell panel, not an app.
// It configures the framework itself (which model the kernel talks to, the system
// prompt), not anything domain-specific.
// "Whatever configures the framework belongs to the shell, whatever does work is always an app" — that line stays firm.
const DRIVERS = [
  { id: "responses", labelKey: "settings.driver.responses" },
  { id: "chat", labelKey: "settings.driver.chat" },
];

type Account = { signedIn: boolean; email?: string; credits?: number | null; rechargeUrl?: string; revoked?: boolean };

export function Settings() {
  const [form, setForm] = useState({ driver: "responses", apiUrl: "", apiKey: "", model: "", system: "" });
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [accountError, setAccountError] = useState("");

  const loadConnection = () =>
    api<{ settings?: Record<string, string> }>("/api/settings").then((j) => {
      const s = j.settings || {};
      setForm({
        driver: s.driver || "responses",
        apiUrl: s.apiUrl || "",
        apiKey: s.apiKey || "",   // the kernel echoes back a ******** placeholder; sending it back unchanged = no change
        model: s.model || "",
        system: s.system || "",
      });
      setLoading(false);
    });
  const loadAccount = () => api<Account>("/api/account").then(setAccount).catch(() => setAccount({ signedIn: false }));

  useEffect(() => { void loadConnection(); void loadAccount(); }, []);
  // Sign-in completes in the browser; the kernel reports it over realtime and the panel refreshes itself.
  useEffect(() => on(EV.ACCOUNT_CHANGED, () => { setWaiting(false); void loadConnection(); void loadAccount(); }), []);

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

  const save = async () => {
    await post("/api/settings", form);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const field = (key: "apiUrl" | "apiKey" | "model", label: string, hint?: string, type = "text") => (
    <label className="set-row">
      <span className="set-label">{label}{hint && <em>{hint}</em>}</span>
      <input
        className="set-input"
        type={type}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );

  if (loading) return <div className="set-wrap"><p className="set-hint">{t("settings.loading")}</p></div>;

  return (
    <div className="set-wrap">
      <h2 className="set-title">{t("settings.account")}</h2>
      <p className="set-hint">{t("settings.account.hint")}</p>
      <div className="set-account">
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

      <h2 className="set-title">{t("settings.title")}</h2>
      <p className="set-hint">{t("settings.hint")}</p>

      <label className="set-row">
        <span className="set-label">{t("settings.driver")}</span>
        <select
          className="set-input"
          value={form.driver}
          onChange={(e) => setForm((f) => ({ ...f, driver: e.target.value }))}
        >
          {DRIVERS.map((d) => <option key={d.id} value={d.id}>{t(d.labelKey)}</option>)}
        </select>
      </label>

      {field("apiUrl", t("settings.apiUrl"), t("settings.apiUrl.hint"))}
      {field("apiKey", t("settings.apiKey"), t("settings.apiKey.hint"), "password")}
      {field("model", t("settings.model"))}

      <label className="set-row">
        <span className="set-label">{t("settings.system")}<em>{t("settings.system.hint")}</em></span>
        <textarea
          className="set-input set-textarea"
          rows={5}
          value={form.system}
          onChange={(e) => setForm((f) => ({ ...f, system: e.target.value }))}
        />
      </label>

      <div className="set-actions">
        <button className="set-save" onClick={save}>{t("settings.save")}</button>
        {saved && <span className="set-ok">{t("settings.saved")}</span>}
      </div>
    </div>
  );
}
