# Activity (activity)

Activity monitor. Lists every AI call any app has made through env.AI — which app, a one-line summary, running / done / error, when — and the assistant conversations that are running right now. Read-only.

## Data

No tables of its own. `/api/activity` reads the kernel's activity ledger through `env.AI.activity({ limit })`; `/api/runs` reads the running conversation ids and titles through `env.AI.fetch` (`/api/runs`, `/api/conversations`). The page refreshes itself every three seconds.

## UI

Filter tabs All / Running / Done / Error with counts. Each row: app id, summary, status, time; a failed row shows the error detail. A "Running conversations" strip at the top lists the assistant conversations still working.

## Layout and editing

- `app.json` manifest · `APP.md` this file · `server.js` backend (Worker) · `public/` frontend build output · `src/` frontend source (React)
- **Frontend changes**: edit `src/`, then run `npm install && npm run build` in this directory; the build output lands back in `public/`.
- **Backend changes**: edit `server.js` directly; it takes effect on the next request.
