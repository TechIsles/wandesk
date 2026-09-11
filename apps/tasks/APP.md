# Tasks (tasks)

Tasks. Every AI call any app has made through env.AI — which app, what it asked, what came back, which tools ran, tokens and duration — plus the assistant conversations running right now. Read-only.

## Data

No tables of its own. `/api/tasks?limit=` lists the kernel's tasks (one per env.AI call) and `/api/tasks/:id` returns one task with its thread — every message item the runner produced (system prompt, user prompt, reasoning, tool calls and outputs, replies) — both through `env.AI.tasks`. `/api/runs` reads running conversation ids and titles through `env.AI.fetch` (`/api/runs`, `/api/conversations`). The page refreshes every two seconds.

## UI

Left: the task list with All / Running / Done / Error filters, a text filter, and per-row app, kind, summary, tokens, duration and time. Right: the selected task — status, timing, tokens, the prompt, the reply, every tool call with its arguments and output, and the error if any. A strip above the list shows conversations that are still working.

## Layout and editing

- `app.json` manifest · `APP.md` this file · `server.js` backend (Worker) · `public/` frontend build output · `src/` frontend source (React)
- **Frontend changes**: edit `src/`, then run `npm install && npm run build` in this directory; the build output lands back in `public/`.
- **Backend changes**: edit `server.js` directly; it takes effect on the next request.
