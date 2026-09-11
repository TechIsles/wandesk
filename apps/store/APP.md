# Store (store)

App store. Browse the catalog on wandesk.ai, install an app into `apps/<id>/`, update it when a newer version is published, remove it, and publish any app from this workspace under your Wandesk account. Every package is the whole app directory (without `node_modules` and `data.db`), so what you install ships its `src/` and can be modified like anything else on the desktop.

## Data

No tables of its own. The catalog comes from `wandesk.ai/api/store/*` through `env.APPS.store(path)`; the installed list, install, remove and publish go through `env.APPS.installed / install / remove / publish`. Publishing requires being signed in (Settings → Wandesk account); the desktop's gateway key identifies the publisher.

## UI

Left: search and the catalog; right: the selected app — description, author, version, size, README, and Install / Update / Remove. A "Your apps" view lists everything in this workspace with its version, whether it was modified locally, and a Publish button (apps with `package.json` must ship `src/`). Admin accounts also see a review queue.

## Layout and editing

- `app.json` manifest · `APP.md` this file · `server.js` backend (Worker) · `public/` frontend build output · `src/` frontend source (React)
- **Frontend changes**: edit `src/`, then run `npm install && npm run build` in this directory.
- **Backend changes**: edit `server.js` directly; it takes effect on the next request.
