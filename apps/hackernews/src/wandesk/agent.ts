// The app calling AI: POST /api/agent on its own origin; the backend forwards it to env.AI.
// Each call is one independent completion by the kernel's agent. `schema` asks for JSON matching a JSON Schema;
// the backend parses it into `json` when the model complies.
export type AgentResult = {
  ok: boolean;
  result?: string;
  json?: unknown;
  error?: string;
};

export type AgentOpts = {
  data?: unknown;
  system?: string;
  schema?: unknown;
};

export async function agent(_appId: string, prompt: string, opts: AgentOpts = {}): Promise<AgentResult> {
  const r = await fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, data: opts.data, system: opts.system, schema: opts.schema }),
  });
  return r.json();
}
