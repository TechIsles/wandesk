# Browser (browser)

A real browser. Every tab is a full Chromium page owned by the shell, not an iframe: any site loads regardless of `X-Frame-Options` or CSP, logins and cookies persist across restarts, downloads go through the system save dialog, and DevTools work. Tabs, bookmarks, history, find on page, zoom, and an AI that answers questions from the text of whatever page is open.

## Data

Three tables in this app's database (`apps/browser/data.db`): `app_browser_visits` (one row per visit — url, title, visited_at), `app_browser_bookmarks` (url as the key, title, created_at) and `app_browser_settings` (key/value; today only the search engine). Every page shares one browsing profile, so a site you signed in to in one tab is signed in in the next.

## HTTP API (same origin as the page)

- `GET /api/start` · what the new-tab page is made of: `{ bookmarks, recent, top, settings }`
- `GET /api/suggest?q=` · address-bar completion, bookmarks before frequently visited pages
- `POST /api/visit { url, title }` · record a visit
- `GET /api/history` · `POST /api/history/clear { url? }`
- `POST /api/bookmark { url, title, remove? }` · returns the new bookmark list
- `POST /api/settings { engine }`
- `POST /api/ask { question, text, url, title }` · the AI answers from the supplied page text

## The page itself

The page is not part of this document. The app asks the shell for one (`wandesk.web.open(url)`), then hands it the rectangle it should fill (`wandesk.web.place(id, rect)`); the shell keeps that rectangle in step with the window and pulls the page off screen the moment anything covers it — another window, a menu, this app's own address-bar suggestions — returning a snapshot that is painted in the same spot so the swap is invisible. Navigation, zoom, find, DevTools, page text and script execution all go through `wandesk.web.*`; state comes back through `wandesk.on("web", fn)`.

Because the shell owns the page, this app only runs inside the Wandesk desktop app. Opened anywhere else it says so instead of pretending.

## Layout and editing

- `app.json` manifest · `APP.md` this file · `server.js` backend (Worker) · `public/` frontend build output · `src/` frontend source (React)
- **Frontend changes**: edit `src/`, then run `npm install && npm run build` in this directory.
- **Backend changes**: edit `server.js` directly; it takes effect on the next request.
