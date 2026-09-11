// Program-level parameters (not user settings). User settings live in the database, see data/settings.ts.
const WINDOWS = process.platform === "win32";

export const KERNEL_PORT = Number(process.env.WANDESK_PORT || 9600);

/** The Wandesk site: account sign-in and the AI gateway live there. */
export const WANDESK_SITE = String(process.env.WANDESK_SITE || "https://wandesk.ai").replace(/\/+$/, "");

export const AGENT_LIMITS = {
  errorMaxChars: 4000,
  bash: {
    executable: WINDOWS ? "cmd.exe" : "/bin/bash",
    args: WINDOWS ? ["/d", "/s", "/c"] : ["-lc"],
    minTimeoutMs: 1000,
    defaultTimeoutMs: 120000,
    maxTimeoutMs: 600000,
    maxOutputChars: 60000,
  },
  retry: { attempts: 3, baseMs: 500 },
};

/** Context compaction watermark: once the most recent usage exceeds it, compact before starting the next round. */
export const COMPACT_WATERMARK = Number(process.env.WANDESK_COMPACT || 120000);
