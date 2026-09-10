import { useEffect, useState } from "react";
import { api, post } from "../lib/http";
import { on, EV } from "../lib/realtime";
import { t } from "../lib/i18n";
import { wallpaperCss, cssToStyle } from "../lib/wallpapers";
import "./Setup.css";

// Out-of-box setup — the first thing you see, before any desktop exists. One Aero window ("Set up Wandesk")
// centred on the wallpaper, Welcome Center style: task-dialog header band, step pane on the left,
// grey footer strip with Back / Next. No skip: Wandesk runs on your model, so until one answers there is no desktop.
type Step = "welcome" | "model" | "done";
const STEPS: Step[] = ["welcome", "model", "done"];

export function Setup({ wallpaper, onDone }: { wallpaper: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [form, setForm] = useState({ apiUrl: "", apiKey: "", model: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);   // Browser sign-in in progress
  const [signedIn, setSignedIn] = useState("");    // Account email once the kernel has the gateway key
  const idx = STEPS.indexOf(step);

  // The kernel writes the connection when the browser callback lands; it tells the shell over realtime.
  useEffect(() => on(EV.ACCOUNT_CHANGED, (p) => {
    if (!p?.signedIn) return;
    setWaiting(false); setError("");
    setSignedIn(String(p.email || "")); setStep("done");
  }), []);
  // Fallback for a callback that landed before the socket was up: poll while waiting.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void api<{ signedIn: boolean; email?: string }>("/api/account").then((a) => {
        if (a.signedIn) { setWaiting(false); setSignedIn(a.email || ""); setStep("done"); }
      }).catch(() => { /* kernel busy, try again on the next tick */ });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const signIn = async () => {
    if (busy || waiting) return;
    setError("");
    try {
      const r = await post<{ url?: string; error?: string }>("/api/account/login/start", {});
      if (!r.url) { setError(t("setup.err.signin", { e: r.error || "" })); return; }
      setWaiting(true);
      window.open(r.url, "_blank", "noopener");
    } catch (e: any) {
      setError(t("setup.err.signin", { e: String(e?.message || e) }));
    }
  };

  const field = (key: keyof typeof form, label: string, placeholder: string, type = "text", hint?: string) => (
    <label className="oobe-field">
      <span className="oobe-field-label">{label}</span>
      <input type={type} value={form[key]} placeholder={placeholder} autoComplete="off" spellCheck={false} disabled={busy}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        onKeyDown={(e) => { if (e.key === "Enter") void next(); }} />
      {hint && <span className="oobe-field-hint">{hint}</span>}
    </label>
  );

  const connect = async (): Promise<boolean> => {
    const apiUrl = form.apiUrl.trim(), apiKey = form.apiKey.trim(), model = form.model.trim();
    if (!apiUrl || !apiKey || !model) { setError(t("setup.err.missing")); return false; }
    setBusy(true); setError("");
    try {
      const driver = /chat\/completions/i.test(apiUrl) ? "chat" : "responses";
      // Test first, save only on success — a failed attempt never counts as configured
      const r = await post<{ ok: boolean; error?: string }>("/api/settings/test", { driver, apiUrl, apiKey, model });
      if (!r.ok) { setError(t("setup.err.test", { e: r.error || "" })); return false; }
      await post("/api/settings", { driver, apiUrl, apiKey, model });
      return true;
    } catch (e: any) {
      setError(String(e?.message || e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    if (busy) return;
    if (step === "welcome") setStep("model");
    else if (step === "model") { if (signedIn || await connect()) setStep("done"); }
    else onDone();
  };
  const back = () => { if (!busy && step === "model") { setError(""); setStep("welcome"); } };

  return (
    <div className="oobe" style={cssToStyle(wallpaperCss(wallpaper))}>
      <div className="oobe-dim" />
      {/* The shell's taskbar, empty: the desktop exists but nothing is open yet */}
      <div className="taskbar oobe-taskbar"><div className="tb-start" aria-hidden="true">▦</div><div className="tb-items" /></div>

      <div className="oobe-stage">
        <div className="oobe-win" role="dialog" aria-label={t("setup.topline")}>
          <div className="oobe-winbar">
            <div className="oobe-wtitle"><span aria-hidden="true">🧭</span>{t("setup.topline")}</div>
            <div className="oobe-wbtns" aria-hidden="true"><span className="oobe-wbtn">–</span><span className="oobe-wbtn">▢</span><span className="oobe-wbtn is-close">✕</span></div>
          </div>
          <div className="oobe-winbody">
            <div className="oobe-head">
              <h1>{t(`setup.${step}.title`)}</h1>
              <p>{t(`setup.${step}.sub`)}</p>
            </div>

            <div className="oobe-body">
              <div className="oobe-taskpane">
                {STEPS.map((s, i) => (
                  <div key={s} className={`oobe-step${i === idx ? " is-active" : i < idx ? " is-done" : ""}`}>
                    <span className="oobe-step-ico">{i < idx ? "✓" : i + 1}</span>
                    {t(`setup.step.${s}`)}
                  </div>
                ))}
              </div>

              <div className="oobe-content">
                {step === "welcome" && (
                  <div className="oobe-panel">
                    <div className="oobe-brand"><span className="oobe-mark">W</span><span>Wandesk</span></div>
                    <p>{t("setup.welcome.p1")}</p>
                    <p>{t("setup.welcome.p2")}</p>
                  </div>
                )}
                {step === "model" && (
                  <div className="oobe-panel">
                    <div className="oobe-signin">
                      <button className="oobe-btn is-primary oobe-signin-btn" onClick={signIn} disabled={busy || waiting}>
                        <GoogleMark />{t("setup.model.signin")}
                      </button>
                      <p className="oobe-signin-hint">{t("setup.model.signin.hint")}</p>
                      {waiting && <div className="oobe-status"><span className="oobe-spin" />{t("setup.model.waiting")}</div>}
                    </div>
                    <div className="oobe-or"><span>{t("setup.model.or")}</span></div>
                    <p>{t("setup.model.p1")}</p>
                    {field("apiUrl", t("settings.apiUrl"), "https://api.openai.com/v1/responses")}
                    {field("apiKey", t("settings.apiKey"), "sk-••••••••••••••••", "password")}
                    {field("model", t("settings.model"), "gpt-5.5", "text", t("setup.model.hint"))}
                    {busy && <div className="oobe-status"><span className="oobe-spin" />{t("setup.testing")}</div>}
                    {error && !busy && <div className="oobe-error"><span className="oobe-x">!</span><span>{error}</span></div>}
                  </div>
                )}
                {step === "done" && (
                  <div className="oobe-panel">
                    <div className="oobe-finish-ico">✓</div>
                    {signedIn && <p>{t("setup.model.signedIn", { email: signedIn })}</p>}
                    <p>{t("setup.done.p1")}</p>
                    <p>{t("setup.done.p2")}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="oobe-foot">
              <span className="oobe-foot-note">{t("setup.stepOf", { n: idx + 1 })}</span>
              <button className="oobe-btn" onClick={back} disabled={busy || step !== "model"}>{t("setup.back")}</button>
              <button className="oobe-btn is-primary" onClick={next} disabled={busy}>
                {step === "done" ? t("setup.finish") : t("setup.next")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The Google "G", inline so the wizard needs no network for its own chrome. */
function GoogleMark() {
  return (
    <svg className="oobe-gmark" viewBox="0 0 48 48" width="16" height="16" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/>
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z"/>
      <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/>
    </svg>
  );
}
