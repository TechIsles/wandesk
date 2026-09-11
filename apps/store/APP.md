# Store (store)

App store. Browse the catalog on wandesk.ai, install an app into `apps/<id>/`, update it when a newer version is published, remove it, rate and review apps, and publish any app from this workspace. Every package is the whole app directory (without `node_modules` and `data.db`), so what you install ships its `src/` and can be modified like anything else on the desktop. The store is for signed-in desktops: without a Wandesk account (Settings → Wandesk account) the window shows a sign-in gate.

## Lifecycle

- **Publish** submits one version; it waits for review (admin accounts publish straight to approved). While a version is under review, the version on sale stays available.
- **Review** (admin accounts, the Review tab): approve — the version goes on sale and its manifest becomes the app's — or reject with a reason the publisher sees. The publisher can withdraw a pending version, and resubmits under a higher version number.
- **Take down / relist**: the publisher or an admin can take an app off sale with a reason; an admin take-down can only be lifted by an admin. Desktops that already installed the app keep it.
- **Ratings and reviews**: one rating (1–5) and text per account per app, editable and deletable by its author; admins can delete any; the publisher replies. Publishers cannot rate their own apps.

## Data

No tables of its own. Everything about the catalog — apps, versions and their review state, listing, ratings and reviews — lives on wandesk.ai and goes through `env.APPS.store(path, body?)`, which carries the signed-in account's key; the installed list, install, remove and publish go through `env.APPS.installed / install / remove / publish`.

## UI

Catalog: search and the list on the left (rating, installs, installed / update state); the selected app on the right — description, README, Install / Update / Open / Remove, Take down / Relist for its publisher and admins, ratings summary with histogram, the review form, every review with the publisher's reply, and the version history (with review states and reasons for the publisher and admins). "Your apps" lists everything in this workspace with its version, whether it was modified locally, its state in the store, each submitted version's status (withdraw a pending one, read a rejection's reason) and the Publish button (apps with `package.json` must ship `src/`). Admin accounts get a Review tab with the queue: README, release notes, Approve, Reject with reason.

## Layout and editing

- `app.json` manifest · `APP.md` this file · `server.js` backend (Worker) · `public/` frontend build output · `src/` frontend source (React)
- **Frontend changes**: edit `src/`, then run `npm install && npm run build` in this directory.
- **Backend changes**: edit `server.js` directly; it takes effect on the next request.
