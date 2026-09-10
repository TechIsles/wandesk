# Ramify (ramify)

Creative-branching canvas. One brief is planned into several distinct directions, each generated as a self-contained HTML page, Markdown document or SVG; any version can be branched again, so a project is an ordered tree of alternatives to compare. Nodes can also hold plain text, images, video or audio placed by an agent.

## Data

Two tables in this app's database (`apps/ramify/data.db`): `projects (id, title, prompt, created_at, updated_at)` and `nodes (id, project_id, parent_id, position, type, title, content, created_at, updated_at)`. `type` is `text`, `html`, `markdown`, `svg`, `image`, `video`, `audio` or `error`. For an artifact type, `content` is the file's path relative to `apps/ramify/artifacts/` (`<project-id>/<node-id>.<ext>`); `NULL` means generation is in progress. For `text`, `content` is optional body text; for `error`, the message. The root node is the one whose `parent_id` is `NULL`. A third table `settings (key, value)` holds theme and locale.

Artifacts are real files under `apps/ramify/artifacts/` in the workspace. Agents may write them directly and insert the matching row; the canvas polls and picks the change up within a second.

## HTTP API (same origin as the page)

- `GET /api/projects` · `POST /api/projects { prompt, count? }` · `PUT /api/projects/:id { title }` · `DELETE /api/projects/:id`
- `GET /api/projects/:id/tree` · `GET /api/projects/:id/version`
- `POST /api/projects/:id/nodes { parentId, title, content? | artifactType + artifact }` · `POST /api/projects/:id/nodes/batch { nodes: [{ key, parentId | parentKey, title, … }] }`
- `PUT /api/nodes/:id { title?, content?, parentId?, position? }` · `PUT /api/nodes/:id/artifact { artifactType, artifact }` · `PUT /api/nodes/:id/artifact/error { error }` · `DELETE /api/nodes/:id`
- `GET /api/nodes/:id/html` (rendered document) · `GET /api/nodes/:id/artifact` (raw file) · `GET /api/nodes/:id/artifact/source`
- `POST /api/projects/:id/generate { prompt, count, nodeIds }` · `POST /api/nodes/:id/branch { prompt, count, nodeIds }` — plan directions, then one completion per placeholder node, through `env.AI`.

`artifact` for image / video / audio is a `data:` URI or an absolute URL; for html / markdown / svg it is the source text.

## Layout and editing

- `app.json` manifest · `APP.md` this file · `server.js` backend (Worker, **built from `src/server/`**) · `public/` frontend build output · `src/ui/` frontend source (React) · `src/shared/` types shared by both
- To change either side: edit `src/`, then run `npm install && npm run build` in this directory. Unlike most apps, `server.js` here is a build artifact, not hand-edited source.
