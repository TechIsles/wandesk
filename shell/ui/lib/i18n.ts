// Shell UI language: a single English dictionary, components just write t(key).
//
// The mechanism still exists for a future second language (see CONTRACT.md §9):
// language comes from the kernel's /api/settings `language` field — pulled once at
// startup; after the settings panel saves, the kernel broadcasts EV.LANGUAGE_CHANGED
// and this updates the current language and notifies subscribers to re-render (see useLang).
// The shell only knows this one dictionary — it never touches any domain copy —
// an app's own localization is its own business, at apps/<id>/src/wandesk/i18n.ts.
import { useEffect, useState } from "react";
import { on, startRealtime, EV } from "./realtime";

export type Lang = "en";

const dict: Record<Lang, Record<string, string>> = {
  en: {
    "panel.wallpaper": "Personalize",
    "panel.settings": "Settings",
    "panel.about": "About Wandesk",
    "setup.topline": "Set up Wandesk",
    "setup.step.welcome": "Welcome",
    "setup.step.model": "Connect a model",
    "setup.step.done": "Finish",
    "setup.welcome.title": "Welcome to Wandesk",
    "setup.welcome.sub": "Set up in a few short steps.",
    "setup.welcome.p1": "Wandesk is an AI desktop where every app is just a small website — one the AI can read, edit, and rebuild on the spot, right in front of you.",
    "setup.welcome.p2": "Sign in with your Wandesk account to start right away, or connect a model of your own. Either way, every AI call in Wandesk goes through the connection you choose here.",
    "setup.model.title": "Connect a model",
    "setup.model.sub": "Sign in with your Wandesk account, or connect any OpenAI-compatible endpoint.",
    "setup.model.p1": "Enter the details for the model you'd like Wandesk to use. Wandesk sends one test request before continuing; you can change this later in Settings.",
    "setup.model.signin": "Sign in with Google",
    "setup.model.signin.hint": "Sign in to use the Wandesk gateway. The model connection is configured for you, usage is billed per token, and new accounts start with a credit grant.",
    "setup.model.waiting": "Complete the sign-in in your browser…",
    "setup.model.signedIn": "Signed in as {email}.",
    "setup.model.or": "Or connect your own model",
    "setup.err.signin": "Sign-in could not be started: {e}",
    "setup.model.hint": "The identifier your provider uses for the model, e.g. gpt-5.5.",
    "setup.done.title": "You're all set",
    "setup.done.sub": "The model answered and the connection is saved.",
    "setup.done.p1": "Wandesk is ready — your desktop is just a prompt away.",
    "setup.done.p2": "Click Finish to open your desktop.",
    "setup.stepOf": "Step {n} of 3",
    "setup.next": "Next",
    "setup.back": "Back",
    "setup.finish": "Finish",
    "setup.testing": "Connecting…",
    "setup.err.missing": "All three fields are required.",
    "setup.err.test": "Could not reach the model: {e}",
    "taskbar.apps": "Apps",
    "taskbar.busy": "{n} app(s) calling AI",
    "taskbar.assistant": "Assistant",

    "ctx.assistant": "Open assistant",
    "ctx.refresh": "Refresh desktop",
    "ctx.wallpaper": "Personalize…",
    "ctx.settings": "Settings…",
    "ctx.about": "About",
    "about.tagline": "An AI desktop. Describe an app and the built-in agent writes it into your workspace; the desktop grows an icon on the spot.",
    "about.version": "Version {v}",
    "about.website": "Website",
    "about.source": "Source code on GitHub",
    "about.discord": "Community on Discord",
    "about.what": "How it is built",
    "about.what.p1": "One shell, one AI kernel, one workerd. Everything else is an app: each one is a standard Cloudflare Worker site with its own origin and its own SQLite database. Installing means the directory exists; removing means deleting it.",
    "about.what.p2": "Apps do not share data with each other. They share the same agent, reached through env.AI, so every app gets the same tools, context and memory without knowing anything about the others.",
    "about.license.title": "License",
    "about.license": "Open source under the ISC license. Contributions and issues are welcome on GitHub.",

    "win.minimize": "Minimize",
    "win.maximize": "Maximize",
    "win.close": "Close",

    "appframe.notReady": "App runtime not ready",
    "appframe.checkRuntime": "Make sure workerd is up (see [runtime] in the kernel log)",
    "appframe.starting": "Starting…",

    "wallpaper.scan.gen": "Generating…",
    "wallpaper.scan.draw": "Painting…",
    "wallpaper.scan.soon": "Almost done…",
    "wallpaper.fail": "Generation failed",
    "wallpaper.placeholder": "Describe the wallpaper you want, then generate… (e.g. starry sky / dunes / bamboo)",
    "wallpaper.generate": "Generate",

    "wallpaper.name.bokeh": "Bokeh Morning",
    "wallpaper.name.contour": "Gentle Slope",
    "wallpaper.name.sakura": "Falling Sakura",
    "wallpaper.name.wheat": "Wheat Field",
    "wallpaper.name.yanyu": "Misty Rain",
    "wallpaper.name.birch": "Birch Wood",
    "wallpaper.name.cork": "Corkboard",
    "wallpaper.name.aurora": "Aurora Night",
    "wallpaper.name.linen": "Linen",
    "wallpaper.name.clouds": "Cloud Glow",
    "wallpaper.name.ink": "Ink Black",

    "settings.loading": "Loading…",
    "settings.title": "Model connection",
    "settings.source": "Model source",
    "settings.source.hint": "Where conversations get their model from. Pick one; switching takes effect immediately.",
    "settings.source.active": "Active",
    "settings.source.wandesk": "Wandesk account",
    "settings.source.wandesk.desc": "Sign in and it works, nothing to configure. Usage is billed to your account balance.",
    "settings.source.custom": "Custom gateway",
    "settings.source.custom.desc": "Your own endpoint and API key (OpenAI Responses or Chat Completions).",
    "settings.source.custom.note": "Takes effect once all three fields are filled. Switching back to the Wandesk account keeps this configuration.",
    "settings.hint": "The kernel runs every AI call through this — anything an app calls via env.AI goes through this one place. Switching providers only means changing the address, no app code changes.",
    "settings.driver": "Protocol driver",
    "settings.driver.responses": "Responses (OpenAI and compatible gateways)",
    "settings.driver.chat": "Chat Completions (for services like GLM that only expose this API)",
    "settings.apiUrl": "Endpoint URL",
    "settings.apiUrl.hint": "e.g. https://api.openai.com/v1/responses",
    "settings.apiKey": "API Key",
    "settings.apiKey.hint": "Write-only — once saved it's never echoed back",
    "settings.model": "Model ID",
    "settings.context": "Context management",
    "settings.context.hint": "How long conversations and tool output are handled. The defaults are usually fine.",
    "settings.context.compact": "Compaction",
    "settings.context.compact.on": "Compact at",
    "settings.context.compact.off": "Off",
    "settings.context.compact.hint": "When a conversation reaches this many tokens, earlier history is summarized before the next turn. Default 100,000.",
    "settings.context.tokens": "tokens",
    "settings.context.chars": "characters",
    "settings.context.toolOutput": "Tool output cap",
    "settings.context.toolOutput.hint": "Maximum characters kept from one command's output. Default 40,000; allowed range 1,000–200,000.",
    "settings.context.rounds": "Tool rounds",
    "settings.context.rounds.on": "At most",
    "settings.context.rounds.off": "Unlimited",
    "settings.context.roundsUnit": "rounds",
    "settings.context.rounds.hint": "How many tool calls one turn may make before it is stopped. Default 32. Unlimited runs until the model stops on its own.",
    "settings.context.prompt": "Compaction prompt",
    "settings.context.prompt.placeholder": "You are compacting a conversation so the agent can continue working seamlessly. Preserve the user's goals and constraints, what has already been done, key facts, paths, commands, errors, unfinished parts, and the next steps. Output only continuous summary prose — no tool calls, tags, or code fences.",
    "settings.context.prompt.hint": "Instructions given to the model when it summarizes earlier history. Leave empty to use the built-in prompt shown above.",
    "settings.system": "System prompt",
    "settings.system.hint": "Sent with every conversation. The kernel appends long-term memory after it.",
    "settings.save": "Save",
    "settings.saved": "Saved",
    "settings.account": "Wandesk account",
    "settings.account.hint": "Signing in configures the model connection automatically and bills usage to your Wandesk balance.",
    "settings.account.signedIn": "Signed in as {email}",
    "settings.account.credits": "Balance: {n} credits",
    "settings.account.creditsUnknown": "Balance unavailable",
    "settings.account.revoked": "The gateway key for this account is no longer valid. Sign in again.",
    "settings.account.topUp": "Top up",
    "settings.account.signOut": "Sign out",
    "settings.account.signIn": "Sign in with Google",
    "settings.account.waiting": "Complete the sign-in in your browser…",
    "settings.account.err": "Sign-in could not be started: {e}",
  },
};

let lang: Lang = "en";
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

/** Pulls the kernel settings once at startup for the `language` field; after that, updates come from the LANGUAGE_CHANGED event. */
export const initI18n = async () => {
  startRealtime();
  try {
    const j = await fetch("/api/settings").then((r) => r.json());
    const v = j?.settings?.language;
    if (v === "en") lang = v;
  } catch { /* fall back to the default on failure */ }
  notify();
};

on(EV.LANGUAGE_CHANGED, (p) => {
  const v = p?.language;
  if (v === "en") { lang = v; notify(); }
});

export const currentLang = (): Lang => lang;

export const t = (key: string, vars?: Record<string, string | number>): string => {
  let s = dict.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
};

/** React hook: subscribes to language changes and triggers a re-render when it changes. */
export const useLang = (): Lang => {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return lang;
};
