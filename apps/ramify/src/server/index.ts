// Ramify on Wandesk — the creative-branching canvas as a Worker site.
//
// Ported from the standalone Ramify runtime (Node + node:sqlite + a data directory) onto the app
// contract: the tree lives in env.DB, artifacts are real files under apps/ramify/artifacts/ written
// through env.FS (so the agent can read and write them with its own tools), generation goes through
// env.AI, and the HTTP API keeps the same shape as upstream so the UI is untouched.
//
// This file is bundled into ../../server.js by build.mjs. Edit here, then `npm run build`.
import { marked } from 'marked';
import { isArtifactType, isLocale, isThemePreference, type AppSettings, type ArtifactType, type NodeType } from '../shared/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type Env = {
  DB: { prepare(sql: string): Stmt; exec(script: string): Promise<unknown>; batch(statements: Stmt[]): Promise<D1Result[]> };
  ASSETS: { fetch(req: Request): Promise<Response> };
  AI: { ask(req: { summary: string; prompt: string; system?: string }): Promise<{ ok: boolean; text?: string; error?: string }> };
  FS: {
    list(path: string): Promise<{ entries: Array<{ name: string; dir: boolean; size: number; mtime: string; path: string }> }>;
    read(path: string): Promise<{ content: string }>;
    readBase64(path: string): Promise<{ b64: string }>;
    write(path: string, content: string): Promise<unknown>;
    writeBase64(path: string, b64: string): Promise<unknown>;
    mkdir(path: string): Promise<unknown>;
    delete(path: string): Promise<unknown>;
  };
  log?: (...args: unknown[]) => void;
};
type Ctx = { waitUntil(p: Promise<unknown>): void };
type Stmt = { bind(...values: unknown[]): Stmt; all<T = any>(): Promise<D1Result<T>>; first<T = any>(): Promise<T | null>; run(): Promise<D1Result> };
type D1Result<T = any> = { results: T[]; meta: { changes: number; last_row_id: number } };

type Project = { id: string; title: string; prompt: string; created_at: string; updated_at: string };
type Node = { id: string; project_id: string; parent_id: string | null; position: number; type: NodeType; title: string; content: string | null; created_at: string; updated_at: string };

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'REQUEST_FAILED') { super(message); }
}

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'html', 'markdown', 'svg', 'image', 'video', 'audio', 'error')),
  title TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (type IS NOT 'error' OR content IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id, parent_id, position);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, position);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

let ready = false;
const ensure = async (env: Env) => {
  if (ready) return;
  await env.DB.exec(SCHEMA);
  ready = true;
};

const NOW = "strftime('%Y-%m-%d %H:%M:%f','now')";
const createId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

// ── Database helpers ──────────────────────────────────────────────────────────

const q = <T = any>(env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).all<T>().then((r) => r.results);
const one = <T = any>(env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).first<T>();
const run = (env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run().then((r) => r.meta.changes);
const stmt = (env: Env, sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params);
/** One transaction. */
const batch = (env: Env, statements: Stmt[]) => env.DB.batch(statements);

const TREE_QUERY = `
  WITH RECURSIVE tree AS (
    SELECT n.*, printf('%010d:%s', n.position, n.id) AS sort_path
    FROM nodes n WHERE n.project_id=? AND n.parent_id IS NULL
    UNION ALL
    SELECT n.*, tree.sort_path || '/' || printf('%010d:%s', n.position, n.id)
    FROM nodes n JOIN tree ON n.parent_id=tree.id
  )
  SELECT id, project_id, parent_id, position, type, title, content, created_at, updated_at,
    ROW_NUMBER() OVER (ORDER BY sort_path) AS seq
  FROM tree ORDER BY sort_path
`;
const SUBTREE = `WITH RECURSIVE subtree(id) AS (SELECT id FROM nodes WHERE id=? UNION ALL SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id=subtree.id)`;

const findProject = (env: Env, id: string) => one<Project>(env, 'SELECT * FROM projects WHERE id=?', id);
const requireProject = async (env: Env, id: string) => {
  const project = await findProject(env, id);
  if (!project) throw new HttpError(404, 'project not found', 'PROJECT_NOT_FOUND');
  return project;
};
const findNode = (env: Env, id: string) => one<Node>(env, 'SELECT * FROM nodes WHERE id=?', id);
const requireNode = async (env: Env, id: string) => {
  const node = await findNode(env, id);
  if (!node) throw new HttpError(404, 'node not found', 'NODE_NOT_FOUND');
  return node;
};
const findNodeInProject = (env: Env, id: string, projectId: string) => one<Node>(env, 'SELECT * FROM nodes WHERE id=? AND project_id=?', id, projectId);
const nextPosition = async (env: Env, projectId: string, parentId: string) =>
  Number((await one<{ position: number }>(env, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM nodes WHERE project_id=? AND parent_id=?', projectId, parentId))?.position ?? 0);
const touch = (env: Env, projectId: string) => stmt(env, `UPDATE projects SET updated_at=${NOW} WHERE id=?`, projectId);
const isInSubtree = async (env: Env, rootId: string, nodeId: string) =>
  Boolean(await one(env, `${SUBTREE} SELECT 1 AS found FROM subtree WHERE id=? LIMIT 1`, rootId, nodeId));

// ── Artifacts: real files under apps/ramify/artifacts/<project>/<node>.<ext>, through env.FS ──

const ARTIFACT_ROOT = 'apps/ramify/artifacts';
const TEXT_FORMATS: Partial<Record<ArtifactType, { extension: string; mime: string }>> = {
  html: { extension: 'html', mime: 'text/html; charset=utf-8' },
  markdown: { extension: 'md', mime: 'text/markdown; charset=utf-8' },
  svg: { extension: 'svg', mime: 'image/svg+xml' },
};
const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/svg+xml': 'svg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/ogg': 'ogv', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'webm',
};
const EXTENSION_MIMES = Object.fromEntries(Object.entries(MEDIA_EXTENSIONS).map(([mime, ext]) => [ext, mime])) as Record<string, string>;
const MEDIA_TYPES = new Set<ArtifactType>(['image', 'video', 'audio']);

const artifactPath = (node: Node) => (isArtifactType(node.type) ? node.content : null);
const validPath = (rel: string) => /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(rel);
const abs = (rel: string) => { if (!validPath(rel)) throw new HttpError(500, 'invalid artifact path', 'INVALID_ARTIFACT_PATH'); return `${ARTIFACT_ROOT}/${rel}`; };
const extensionOf = (rel: string) => rel.split('.').pop() || 'bin';

const decodeDataUri = (value: string, type: ArtifactType) => {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(value.trim());
  if (!match || !match[1].toLowerCase().startsWith(`${type}/`)) throw new HttpError(400, `invalid ${type} data URI`, 'INVALID_MEDIA_SOURCE');
  const mime = match[1].toLowerCase();
  const b64 = match[2] ? match[3].replace(/\s/g, '') : btoa(unescape(encodeURIComponent(decodeURIComponent(match[3]))));
  if (!b64) throw new HttpError(400, `empty ${type} data URI`, 'INVALID_MEDIA_SOURCE');
  return { b64, mime, extension: MEDIA_EXTENSIONS[mime] || 'bin' };
};

const artifacts = {
  async write(env: Env, projectId: string, nodeId: string, type: ArtifactType, content: string): Promise<string> {
    const text = TEXT_FORMATS[type];
    if (text) {
      const rel = `${projectId}/${nodeId}.${text.extension}`;
      await env.FS.write(abs(rel), content);
      return rel;
    }
    if (content.trim().startsWith('data:')) {
      const { b64, extension } = decodeDataUri(content, type);
      const rel = `${projectId}/${nodeId}.${extension}`;
      await env.FS.writeBase64(abs(rel), b64);
      return rel;
    }
    const rel = `${projectId}/${nodeId}.url`;
    await env.FS.write(abs(rel), `${content.trim()}\n`);
    return rel;
  },
  mime(rel: string, type: ArtifactType) {
    if (rel.endsWith('.url')) return 'text/uri-list; charset=utf-8';
    const text = TEXT_FORMATS[type];
    if (text) return text.mime;
    return EXTENSION_MIMES[extensionOf(rel)] || 'application/octet-stream';
  },
  async readText(env: Env, rel: string) {
    try { return (await env.FS.read(abs(rel))).content; }
    catch { throw new HttpError(404, 'artifact file not found', 'ARTIFACT_FILE_NOT_FOUND'); }
  },
  async readBase64(env: Env, rel: string) {
    try { return (await env.FS.readBase64(abs(rel))).b64; }
    catch { throw new HttpError(404, 'artifact file not found', 'ARTIFACT_FILE_NOT_FOUND'); }
  },
  async source(env: Env, rel: string, type: ArtifactType) {
    const mime = this.mime(rel, type);
    if (mime.startsWith('text/uri-list')) return (await this.readText(env, rel)).trim();
    if (mime.startsWith('text/') || mime.startsWith('image/svg+xml')) return this.readText(env, rel);
    return `data:${mime.split(';')[0]};base64,${await this.readBase64(env, rel)}`;
  },
  async remove(env: Env, rel: string | null | undefined) {
    if (!rel || !validPath(rel)) return;
    try { await env.FS.delete(abs(rel)); } catch { /* already gone */ }
  },
  async removeMany(env: Env, rels: Array<string | null>) {
    for (const rel of new Set(rels.filter((v): v is string => Boolean(v)))) await this.remove(env, rel);
  },
  async removeProject(env: Env, projectId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) return;
    try { await env.FS.delete(`${ARTIFACT_ROOT}/${projectId}`); } catch { /* nothing there */ }
  },
  /** One directory listing per project: revision = mtime + size of each file, keyed by relative path. */
  async revisions(env: Env, projectId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) return map;
    try {
      const { entries } = await env.FS.list(`${ARTIFACT_ROOT}/${projectId}`);
      for (const e of entries) if (!e.dir) map.set(`${projectId}/${e.name}`, `${Date.parse(e.mtime) || 0}:${e.size}`);
    } catch { /* no artifacts yet */ }
    return map;
  },
};

// ── Rendering (artifact → a full document for the preview iframe) ─────────────

const MD_STYLE = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#faf7f2;color:#2b2620;font:16px/1.75 Georgia,'Songti SC','Noto Serif SC',serif;-webkit-font-smoothing:antialiased}
  main{max-width:720px;margin:0 auto;padding:56px 32px 88px}
  h1,h2,h3,h4,h5,h6{color:#171310;line-height:1.3;margin:2em 0 .6em;font-weight:700}
  h1{font-size:2rem;margin-top:.4em}
  h2{font-size:1.5rem;padding-bottom:.35em;border-bottom:1px solid #e7ded0}
  h3{font-size:1.2rem}
  p{margin:.9em 0}
  a{color:#b3492f;text-decoration:underline;text-underline-offset:3px}
  strong{color:#171310}
  blockquote{margin:1.4em 0;padding:.2em 1.2em;border-left:3px solid #c9a27a;background:#f3ece1;color:#5a4f42;border-radius:0 8px 8px 0}
  code{font:.86em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#efe8dc;padding:.15em .4em;border-radius:5px}
  pre{background:#211d18;color:#e8e0d2;padding:18px 20px;border-radius:12px;overflow-x:auto;margin:1.4em 0}
  pre code{background:none;padding:0;color:inherit}
  ul,ol{padding-left:1.5em;margin:.9em 0}
  li{margin:.3em 0}
  table{border-collapse:collapse;width:100%;margin:1.4em 0;font-size:.94em}
  th,td{border:1px solid #e0d6c5;padding:.55em .8em;text-align:left}
  th{background:#f1eadd}
  hr{border:0;border-top:1px solid #e0d6c5;margin:2.4em auto;width:52%}
  img{max-width:100%}
`;
const SVG_STYLE = `
  html,body{margin:0;height:100%}
  body{display:grid;place-items:center;background:#f4f1ea;background-image:radial-gradient(#00000010 1px,transparent 1px);background-size:18px 18px}
  svg{max-width:92vw;max-height:92vh;filter:drop-shadow(0 10px 30px rgba(20,16,10,.14))}
`;
const MEDIA_STYLE = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  html,body{margin:0;width:100%;height:100%}
  body{display:grid;place-items:center;padding:24px;background:#f4f1ea;background-image:radial-gradient(#00000010 1px,transparent 1px);background-size:18px 18px}
  img,video{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;box-shadow:0 18px 48px rgba(20,16,10,.16)}
  audio{width:min(560px,100%)}
`;
const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (v: string) => escapeHtml(v).replace(/"/g, '&quot;');
const standardsDocument = (doc: string) => (/^\s*<!doctype[^>]*>/i.test(doc) ? doc : `<!DOCTYPE html>${doc}`);
const page = (style: string, body: string) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${style}</style></head><body>${body}</body></html>`;

function renderArtifact(content: string, type: ArtifactType): string {
  if (MEDIA_TYPES.has(type)) {
    const src = escapeAttribute(content.trim());
    const media = type === 'image' ? `<img src="${src}" alt="Generated image">`
      : type === 'video' ? `<video src="${src}" controls playsinline preload="metadata"></video>`
        : `<audio src="${src}" controls preload="metadata"></audio>`;
    return page(MEDIA_STYLE, media);
  }
  if (type === 'markdown') return page(MD_STYLE, `<main>${marked.parse(content, { async: false }) as string}</main>`);
  if (type === 'svg') return page(SVG_STYLE, content);
  return standardsDocument(content);
}

// ── Input helpers ─────────────────────────────────────────────────────────────

const requireTitle = (v: unknown) => { const t = typeof v === 'string' ? v.trim() : ''; if (!t) throw new HttpError(400, 'title required', 'TITLE_REQUIRED'); return t; };
const optionalContent = (v: unknown) => (typeof v === 'string' && v.length ? v : null);
const positionOf = (v: unknown, fallback: number) => {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || Number(v) < 0) throw new HttpError(400, 'position must be a non-negative integer', 'INVALID_POSITION');
  return Number(v);
};
const requireArtifactSource = (v: unknown) => { const s = typeof v === 'string' ? v : ''; if (!s.trim()) throw new HttpError(400, 'artifact required', 'ARTIFACT_REQUIRED'); return s; };
const artifactTypeOf = (v: unknown, key?: string): ArtifactType | null => {
  if (v === undefined || v === null) return null;
  if (isArtifactType(v)) return v;
  throw new HttpError(400, key ? `invalid artifactType for ${key}` : 'invalid artifactType', 'INVALID_ARTIFACT_TYPE');
};
const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  let value: unknown;
  try { value = await req.json(); } catch { throw new HttpError(400, 'invalid JSON', 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON object required', 'INVALID_BODY');
  return value as Record<string, unknown>;
};

// ── Projects ──────────────────────────────────────────────────────────────────

const projects = {
  list: (env: Env) => q(env, `
    SELECT p.*,
      (SELECT COUNT(*) FROM nodes n WHERE n.project_id=p.id AND n.parent_id IS NOT NULL) AS node_count,
      (SELECT COUNT(*) FROM nodes n WHERE n.project_id=p.id
        AND n.type IN ('html','markdown','svg','image','video','audio') AND n.content IS NULL) AS generating_count,
      (SELECT n.id FROM nodes n WHERE n.project_id=p.id AND n.parent_id IS NOT NULL
        AND n.type IN ('html','markdown','svg','image','video','audio') AND n.content IS NOT NULL
        ORDER BY n.created_at DESC LIMIT 1) AS preview_node_id
    FROM projects p ORDER BY p.updated_at DESC`),

  async version(env: Env) {
    // Project count + newest project stamp + newest node stamp: any change through the API or direct SQL moves it.
    const row = await one<{ count: number; latest: string; nodes: string }>(env,
      `SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS latest, (SELECT COALESCE(MAX(updated_at), '') || ':' || COUNT(*) FROM nodes) AS nodes FROM projects`);
    return `${row?.count ?? 0}:${row?.latest ?? ''}:${row?.nodes ?? ''}`;
  },

  async treeVersion(env: Env, projectId: string) {
    const project = await requireProject(env, projectId);
    const row = await one<{ count: number; latest: string }>(env, 'SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), \'\') AS latest FROM nodes WHERE project_id=?', projectId);
    // Artifact files can be rewritten in place by the agent; fold their stamps in so the canvas notices.
    const files = [...(await artifacts.revisions(env, projectId)).values()].join(',');
    return `${project.updated_at}|${row?.count ?? 0}:${row?.latest ?? ''}|${files}`;
  },

  async create(env: Env, input: Record<string, unknown>) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) throw new HttpError(400, 'prompt is required', 'PROMPT_REQUIRED');
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : prompt.slice(0, 20);
    const count = input.count === undefined ? 0 : Number(input.count);
    if (!Number.isInteger(count) || count < 0 || count > 5) throw new HttpError(400, 'count must be an integer between 0 and 5', 'INVALID_COUNT');
    const projectId = createId();
    const rootId = createId();
    const nodeIds = Array.from({ length: count }, () => createId());
    await batch(env, [
      stmt(env, 'INSERT INTO projects (id, title, prompt) VALUES (?, ?, ?)', projectId, title, prompt),
      stmt(env, 'INSERT INTO nodes (id, project_id, parent_id, position, title) VALUES (?, ?, NULL, 0, ?)', rootId, projectId, prompt),
      ...nodeIds.map((id, position) => stmt(env, 'INSERT INTO nodes (id, project_id, parent_id, position, type, title, content) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        id, projectId, rootId, position, 'html', `Version ${position + 1} (generating)`)),
    ]);
    return { ...(await requireProject(env, projectId)), rootId, nodeIds };
  },

  async rename(env: Env, projectId: string, input: Record<string, unknown>) {
    await requireProject(env, projectId);
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new HttpError(400, 'title is required', 'TITLE_REQUIRED');
    const expected = typeof input.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt : undefined;
    const changed = expected
      ? await run(env, `UPDATE projects SET title=?, updated_at=${NOW} WHERE id=? AND updated_at=?`, title, projectId, expected)
      : await run(env, `UPDATE projects SET title=?, updated_at=${NOW} WHERE id=?`, title, projectId);
    if (!changed) throw new HttpError(409, 'project changed since it was read', 'VERSION_CONFLICT');
    return requireProject(env, projectId);
  },

  async delete(env: Env, projectId: string) {
    await batch(env, [stmt(env, 'DELETE FROM nodes WHERE project_id=?', projectId), stmt(env, 'DELETE FROM projects WHERE id=?', projectId)]);
    await artifacts.removeProject(env, projectId);
    return { ok: true as const };
  },

  async tree(env: Env, projectId: string) {
    const project = await requireProject(env, projectId);
    const revisions = await artifacts.revisions(env, projectId);
    const list = await q<Node & { seq: number }>(env, TREE_QUERY, projectId);
    const nodes = list.map((node) => {
      const rel = artifactPath(node);
      return { ...node, artifact_revision: rel ? (revisions.get(rel) || 'missing') : '' };
    });
    return { project, nodes };
  },
};

// ── Nodes ─────────────────────────────────────────────────────────────────────

type NewNode = { id: string; projectId: string; parentId: string; position: number; type: NodeType; title: string; content: string | null };
const insertNode = (env: Env, n: NewNode) =>
  stmt(env, 'INSERT INTO nodes (id, project_id, parent_id, position, type, title, content) VALUES (?, ?, ?, ?, ?, ?, ?)', n.id, n.projectId, n.parentId, n.position, n.type, n.title, n.content);
const updateNode = async (env: Env, id: string, parentId: string | null, position: number, type: NodeType, title: string, content: string | null, expected?: string, projectId?: string) => {
  const sql = `UPDATE nodes SET parent_id=?, position=?, type=?, title=?, content=?, updated_at=${NOW} WHERE id=?${expected ? ' AND updated_at=?' : ''}`;
  const params = expected ? [parentId, position, type, title, content, id, expected] : [parentId, position, type, title, content, id];
  const results = await batch(env, [stmt(env, sql, ...params), ...(projectId ? [touch(env, projectId)] : [])]);
  return results[0]?.meta?.changes ?? 0;
};

const nodes = {
  async create(env: Env, projectId: string, input: Record<string, unknown>) {
    await requireProject(env, projectId);
    const parentId = typeof input.parentId === 'string' ? input.parentId : '';
    if (!parentId) throw new HttpError(400, 'parentId required', 'PARENT_REQUIRED');
    if (!(await findNodeInProject(env, parentId, projectId))) throw new HttpError(404, 'parent node not found', 'PARENT_NOT_FOUND');
    const artifactType = artifactTypeOf(input.artifactType);
    if (input.artifact !== undefined && !artifactType) throw new HttpError(400, 'artifactType required', 'ARTIFACT_TYPE_REQUIRED');
    if (artifactType && input.content !== undefined && input.content !== null) throw new HttpError(400, 'content cannot be combined with artifactType', 'AMBIGUOUS_NODE_CONTENT');
    const title = requireTitle(input.title);
    const id = createId();
    const source = artifactType && input.artifact !== undefined ? requireArtifactSource(input.artifact) : null;
    const artifact = source && artifactType ? await artifacts.write(env, projectId, id, artifactType, source) : null;
    try {
      await batch(env, [
        insertNode(env, { id, projectId, parentId, position: positionOf(input.position, await nextPosition(env, projectId, parentId)), type: artifactType ?? 'text', title, content: artifactType ? artifact : optionalContent(input.content) }),
        touch(env, projectId),
      ]);
    } catch (error) {
      await artifacts.remove(env, artifact);
      throw error;
    }
    return { id };
  },

  async createBatch(env: Env, projectId: string, input: Record<string, unknown>) {
    await requireProject(env, projectId);
    if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new HttpError(400, 'nodes must be a non-empty array', 'NODES_REQUIRED');
    if (input.nodes.length > 100) throw new HttpError(400, 'batch is limited to 100 nodes', 'BATCH_TOO_LARGE');
    const written: string[] = [];
    try {
      const ids = new Map<string, string>();
      const created: Array<{ key: string; id: string }> = [];
      const statements: Stmt[] = [];
      const positions = new Map<string, number>(); // next free position per parent, so siblings in one batch don't collide
      for (const raw of input.nodes as unknown[]) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'each batch node must be an object', 'INVALID_BATCH_NODE');
        const item = raw as Record<string, unknown>;
        const key = typeof item.key === 'string' ? item.key.trim() : '';
        if (!key || ids.has(key)) throw new HttpError(400, 'batch node keys must be unique', 'INVALID_BATCH_KEY');
        const parentId = typeof item.parentKey === 'string' ? ids.get(item.parentKey) : typeof item.parentId === 'string' ? item.parentId : undefined;
        if (!parentId || (!ids.has(String(item.parentKey)) && !(await findNodeInProject(env, parentId, projectId)))) throw new HttpError(404, `parent not found for ${key}`, 'PARENT_NOT_FOUND');
        const artifactType = artifactTypeOf(item.artifactType, key);
        if (item.artifact !== undefined && !artifactType) throw new HttpError(400, `artifactType required for ${key}`, 'ARTIFACT_TYPE_REQUIRED');
        if (artifactType && item.content !== undefined && item.content !== null) throw new HttpError(400, `content cannot be combined with artifactType for ${key}`, 'AMBIGUOUS_NODE_CONTENT');
        const title = requireTitle(item.title);
        const id = createId();
        const source = artifactType && item.artifact !== undefined ? requireArtifactSource(item.artifact) : null;
        const artifact = source && artifactType ? await artifacts.write(env, projectId, id, artifactType, source) : null;
        if (artifact) written.push(artifact);
        if (!positions.has(parentId)) positions.set(parentId, ids.has(String(item.parentKey)) ? 0 : await nextPosition(env, projectId, parentId));
        const fallback = positions.get(parentId)!;
        const position = positionOf(item.position, fallback);
        positions.set(parentId, Math.max(fallback, position) + 1);
        statements.push(insertNode(env, { id, projectId, parentId, position, type: artifactType ?? 'text', title, content: artifactType ? artifact : optionalContent(item.content) }));
        ids.set(key, id);
        created.push({ key, id });
      }
      statements.push(touch(env, projectId));
      await batch(env, statements);
      return { nodes: created };
    } catch (error) {
      await artifacts.removeMany(env, written);
      throw error;
    }
  },

  async update(env: Env, nodeId: string, input: Record<string, unknown>) {
    const node = await requireNode(env, nodeId);
    const title = input.title === undefined ? node.title : requireTitle(input.title);
    const changesContent = input.content !== undefined;
    const type: NodeType = changesContent ? 'text' : node.type;
    const content = changesContent ? optionalContent(input.content) : node.content;
    let parentId = node.parent_id;
    if (input.parentId !== undefined) {
      if (!node.parent_id) throw new HttpError(400, 'root node cannot be moved', 'ROOT_NODE_MOVE_NOT_ALLOWED');
      parentId = typeof input.parentId === 'string' ? input.parentId : '';
      if (!(await findNodeInProject(env, parentId, node.project_id))) throw new HttpError(404, 'parent node not found', 'PARENT_NOT_FOUND');
      if (parentId === nodeId || (await isInSubtree(env, nodeId, parentId))) throw new HttpError(400, 'move would create a cycle', 'TREE_CYCLE');
    }
    const expected = typeof input.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt : undefined;
    if (!(await updateNode(env, nodeId, parentId, positionOf(input.position, node.position), type, title, content, expected, node.project_id))) {
      throw new HttpError(409, 'node changed since it was read', 'VERSION_CONFLICT');
    }
    if (changesContent) await artifacts.remove(env, artifactPath(node));
    return requireNode(env, nodeId);
  },

  async updateArtifact(env: Env, nodeId: string, input: Record<string, unknown>) {
    const node = await requireNode(env, nodeId);
    if (!isArtifactType(input.artifactType)) throw new HttpError(400, 'artifactType required', 'ARTIFACT_TYPE_REQUIRED');
    const type = input.artifactType;
    const expected = typeof input.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt : undefined;
    if (expected && expected !== node.updated_at) throw new HttpError(409, 'node changed since it was read', 'VERSION_CONFLICT');
    const previous = artifactPath(node);
    const artifact = await artifacts.write(env, node.project_id, nodeId, type, requireArtifactSource(input.artifact));
    try {
      if (!(await updateNode(env, nodeId, node.parent_id, node.position, type, node.title, artifact, expected, node.project_id))) {
        throw new HttpError(409, 'node changed since it was read', 'VERSION_CONFLICT');
      }
    } catch (error) {
      if (previous !== artifact) await artifacts.remove(env, artifact);
      throw error;
    }
    if (previous !== artifact) await artifacts.remove(env, previous);
    return { ok: true as const };
  },

  async markArtifactError(env: Env, nodeId: string, input: Record<string, unknown>) {
    const node = await requireNode(env, nodeId);
    if (!isArtifactType(node.type)) throw new HttpError(400, 'node has no artifact', 'ARTIFACT_TYPE_REQUIRED');
    const error = typeof input.error === 'string' ? input.error.trim() : '';
    if (!error) throw new HttpError(400, 'error required', 'ERROR_REQUIRED');
    const expected = typeof input.expectedUpdatedAt === 'string' ? input.expectedUpdatedAt : undefined;
    if (!(await updateNode(env, nodeId, node.parent_id, node.position, 'error', node.title, error, expected, node.project_id))) {
      throw new HttpError(409, 'node changed since it was read', 'VERSION_CONFLICT');
    }
    await artifacts.remove(env, artifactPath(node));
    return { ok: true as const };
  },

  async clearArtifact(env: Env, nodeId: string) {
    const node = await requireNode(env, nodeId);
    await updateNode(env, nodeId, node.parent_id, node.position, 'text', node.title, null, undefined, node.project_id);
    await artifacts.remove(env, artifactPath(node));
    return { ok: true as const };
  },

  async delete(env: Env, nodeId: string) {
    const node = await requireNode(env, nodeId);
    if (!node.parent_id) throw new HttpError(400, 'root node cannot be deleted', 'ROOT_NODE_IMMUTABLE');
    const subtree = await q<Node>(env, `${SUBTREE} SELECT * FROM nodes WHERE id IN (SELECT id FROM subtree)`, nodeId);
    const results = await batch(env, [
      stmt(env, `${SUBTREE} DELETE FROM nodes WHERE id IN (SELECT id FROM subtree)`, nodeId),
      touch(env, node.project_id),
    ]);
    await artifacts.removeMany(env, subtree.map(artifactPath));
    return { ok: true as const, deleted: results[0]?.meta?.changes ?? subtree.length };
  },

  async requireArtifactNode(env: Env, nodeId: string) {
    const node = await requireNode(env, nodeId);
    if (!isArtifactType(node.type) || !node.content) throw new HttpError(404, 'artifact not found', 'ARTIFACT_NOT_FOUND');
    return node;
  },

  async html(env: Env, nodeId: string) {
    const node = await this.requireArtifactNode(env, nodeId);
    const type = node.type as ArtifactType;
    const rel = node.content as string;
    const mime = artifacts.mime(rel, type);
    const source = MEDIA_TYPES.has(type)
      ? mime.startsWith('text/uri-list') ? (await artifacts.readText(env, rel)).trim() : `/api/nodes/${node.id}/artifact`
      : await artifacts.readText(env, rel);
    return renderArtifact(source, type);
  },

  async artifactSource(env: Env, nodeId: string) {
    const node = await this.requireArtifactNode(env, nodeId);
    return { source: await artifacts.source(env, node.content as string, node.type as ArtifactType), artifactType: node.type };
  },
};

// ── Settings (theme / locale), one row per key ───────────────────────────────

const DEFAULT_SETTINGS: AppSettings = { theme: 'system', locale: 'en' };
const settings = {
  async read(env: Env): Promise<AppSettings> {
    const rows = await q<{ key: string; value: string }>(env, 'SELECT key, value FROM settings');
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      theme: isThemePreference(map.theme) ? map.theme : DEFAULT_SETTINGS.theme,
      locale: isLocale(map.locale) ? map.locale : DEFAULT_SETTINGS.locale,
    };
  },
  async write(env: Env, key: 'theme' | 'locale', value: string) {
    await run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
    return this.read(env);
  },
};

// ── Generation: plan the directions (one completion) → one completion per card ─

const CARD_TYPES = ['html', 'markdown', 'svg'] as const;
type CardType = (typeof CARD_TYPES)[number];
type Direction = { title: string; type: CardType; idea: string };

const LANGUAGE_RULE =
  'Language: write every visible word in the same language as the user brief. '
  + 'If the brief names a target audience, market or language, follow that instead. '
  + 'Never mix languages within one piece of work.';
const SHARED_RULES =
  'Output the work itself only — no JSON, no markdown code fences, no explanation, no preamble. '
  + 'Never propose a backend, database, API, account login, payment, multi-page routing or anything needing a server: '
  + 'this tool produces self-contained single-file work only. '
  + LANGUAGE_RULE
  + ' Content must be substantive and believable, and the presentation refined.';
const GENERATOR_SYSTEMS: Record<CardType, string> = {
  html: 'You are a senior designer and front-end engineer. Produce one self-contained HTML document: '
    + 'CSS and JS inlined, no external resources at all (no external fonts, images, scripts or stylesheets). '
    + 'Render imagery with inline SVG, CSS gradients and shapes, or emoji. '
    + 'Never link to external images or placeholder services, and never leave an empty or externally-pointing <img>. '
    + 'Output a complete document starting with <!DOCTYPE html> and ending with </html>. ' + SHARED_RULES,
  markdown: 'You are a senior writer and information architect. Produce one complete, well-structured Markdown document. '
    + 'Use heading levels, lists, tables, quotes and code blocks to organise the content. '
    + 'It must be substantive and immediately usable — no placeholders. '
    + 'Do not embed HTML tags and do not link to external images. Output plain Markdown text directly. ' + SHARED_RULES,
  svg: 'You are a senior illustrator and visual designer. Produce one self-contained SVG work: '
    + 'it must carry a viewBox, keep all styling inline, and use no external resources, no <script> and no bitmaps. '
    + 'Composition complete, detail rich, palette considered; render text with <text>. Output a complete <svg>…</svg>. ' + SHARED_RULES,
};
const PLAN_SYSTEM =
  'You are a senior creative director. Understand what the user actually wants, then split it into executable creative directions. '
  + 'Each direction has a short title, an output type, and an idea — a concrete direction for the downstream creator. '
  + 'Keep title and idea separate. ' + LANGUAGE_RULE + ' Both title and idea follow that same language.\n'
  + 'Each direction picks one output type: html = pages, posters, interfaces, interactive demos; '
  + 'markdown = documents, articles, proposals, reading-first content; svg = logos, icons, illustrations, pure vector work. '
  + 'When the intent is clear, give every direction the same type; mix types only when the user explicitly wants to compare formats. '
  + 'This tool does not produce bitmap photographs: express photo-like intent through svg or html.\n'
  + 'Whatever the user already made explicit — subject, content, aesthetic leaning, audience — is evidence; '
  + 'never change what the user cares about just to manufacture variety. '
  + 'The more specific the brief, the more restrained the differences between directions; '
  + 'only when the brief is open, or the user explicitly asks to diverge, should the directions pull apart on style, structure and mood.\n'
  + 'Every idea must describe in natural language how this version should be made and how it differs from the others, '
  + 'directly executable by the downstream creator.\n'
  + 'Respond with JSON only, no code fences: {"directions":[{"title":string,"type":"html"|"markdown"|"svg","idea":string}, …]}.';
const TYPE_TASK: Record<CardType, string> = {
  html: 'produce one complete single-file HTML page',
  markdown: 'write one complete Markdown document',
  svg: 'produce one complete SVG work',
};
const rootPrompt = (idea: string, type: CardType) => `Following this creative direction, ${TYPE_TASK[type]}:\n\n${idea}`;
const branchPrompt = (parentType: string, parentContent: string, type: CardType, idea: string) =>
  `This is the complete previous version (type: ${parentType}):\n\n${parentContent}\n\n`
  + `Building on it, ${TYPE_TASK[type]} following the direction below. `
  + `The direction decides whether this is a large rework or a small adjustment:\n${idea}`;
function planPrompt(p: { kind: 'root' | 'branch'; count: number; prompt: string; parentType?: string; parentContent?: string }) {
  if (p.kind === 'root') {
    return `User brief:\n${p.prompt}\n\nPlan ${p.count} creative directions that match the user's real intent and are distinguishable from each other, `
      + 'and pick an output type (html/markdown/svg) for each. The more specific the brief, the more restrained the differences. '
      + 'Do not manufacture difference mechanically. Every direction produces one complete piece of work.';
  }
  const context = p.parentContent ? `Previous version (type: ${p.parentType || 'html'}):\n${p.parentContent}` : 'No previous content.';
  return `${context}\n\nUser instruction for this round:\n${p.prompt}\n\nPlan ${p.count} downstream directions that satisfy this instruction, and pick an output type (html/markdown/svg) for each. `
    + "Keep the previous version's type unless the user explicitly asks to change format. "
    + 'For a specific fix, let the versions differ only in detail, pacing or emphasis; for exploration, pull them clearly apart. Do not manufacture difference mechanically.';
}
const stripFence = (text: string) => { const m = String(text || '').trim().match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i); return m ? m[1].trim() : String(text || '').trim(); };
/** Models often wrap the work in prose or fences; cut the document out by its own boundaries. */
const extractDocument = (text: string, type: CardType) => {
  const value = stripFence(text);
  if (type === 'html') {
    const lower = value.toLowerCase();
    const start = (() => { const d = lower.indexOf('<!doctype html'); const h = lower.indexOf('<html'); return d >= 0 && (h < 0 || d <= h) ? d : h; })();
    const end = lower.lastIndexOf('</html>');
    return start >= 0 && end > start ? value.slice(start, end + '</html>'.length) : value;
  }
  if (type === 'svg') {
    const start = value.indexOf('<svg'); const end = value.lastIndexOf('</svg>');
    return start >= 0 && end > start ? value.slice(start, end + '</svg>'.length) : value;
  }
  return value;
};
const normalizeContent = (text: string, type: CardType) => { const c = type === 'markdown' ? String(text || '').trim() : extractDocument(text, type); if (!c) throw new Error('missing_content'); return c; };
const contentError = (type: CardType, content: string) => {
  const v = String(content || '').trim();
  if (!v) return 'missing_content';
  if (type === 'html' && !(/<html[\s>]/i.test(v) && /<\/html>\s*$/i.test(v))) return 'invalid_html_output';
  if (type === 'svg' && (!/<svg[\s>]/i.test(v) || /<script[\s>]/i.test(v))) return 'invalid_svg_output';
  return '';
};
const asType = (v: unknown): CardType => ((CARD_TYPES as readonly string[]).includes(String(v || '').trim().toLowerCase()) ? (String(v).trim().toLowerCase() as CardType) : 'html');
function parseDirections(text: string, count: number): Direction[] {
  let json: any;
  try { json = JSON.parse(stripFence(text)); } catch { throw new Error('plan_not_json'); }
  const raw = Array.isArray(json?.directions) ? json.directions : [];
  const directions: Direction[] = raw
    .map((item: any) => ({ title: String(item?.title || '').trim(), type: asType(item?.type), idea: String(item?.idea || '').trim() }))
    .filter((d: Direction) => d.title && d.idea);
  if (!directions.length) throw new Error('missing_directions');
  return directions.slice(0, count);
}

const complete = async (env: Env, summary: string, system: string, prompt: string) => {
  const out = await env.AI.ask({ summary, system, prompt });
  if (!out.ok) throw new Error(out.error || 'completion failed');
  const text = String(out.text || '');
  if (!text.trim()) throw new Error('empty completion');
  return text;
};

type Job = { kind: 'root' | 'branch'; prompt: string; count: number; nodeIds: string[]; parent?: { type: string; content: string } };
const MAX_PARENT_CHARS = 140_000;
const CONCURRENCY = 3;

async function markFailed(env: Env, nodeId: string, message: string) {
  const node = await findNode(env, nodeId);
  if (!node || !isArtifactType(node.type) || node.content) return; // finished or gone: leave it
  try { await nodes.markArtifactError(env, nodeId, { error: `Generation failed: ${message}` }); }
  catch (error) { env.log?.('[ramify] failed to mark node as failed', nodeId, String(error)); }
}

async function generateOne(env: Env, nodeId: string, direction: Direction, job: Job) {
  try {
    const type = direction.type;
    const prompt = job.kind === 'branch' && job.parent
      ? branchPrompt(job.parent.type, job.parent.content.slice(0, MAX_PARENT_CHARS), type, direction.idea)
      : rootPrompt(direction.idea, type);
    const raw = await complete(env, `Ramify: generate "${direction.title}"`, GENERATOR_SYSTEMS[type], prompt);
    const content = normalizeContent(raw, type);
    const invalid = contentError(type, content);
    if (invalid) throw new Error(invalid);
    await nodes.updateArtifact(env, nodeId, { artifactType: type, artifact: content });
    await nodes.update(env, nodeId, { title: direction.title });
  } catch (error) {
    await markFailed(env, nodeId, error instanceof Error ? error.message : String(error));
  }
}

async function runGeneration(env: Env, job: Job) {
  let directions: Direction[];
  try {
    const plan = await complete(env, `Ramify: plan ${job.count} directions for "${job.prompt.slice(0, 24)}"`, PLAN_SYSTEM, planPrompt({
      kind: job.kind, count: job.count, prompt: job.prompt, parentType: job.parent?.type, parentContent: job.parent?.content.slice(0, MAX_PARENT_CHARS),
    }));
    directions = parseDirections(plan, job.count);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const nodeId of job.nodeIds) await markFailed(env, nodeId, `Planning failed: ${message}`);
    return;
  }
  const assigned = job.nodeIds.map((nodeId, i) => ({ nodeId, direction: directions[i] || directions[directions.length - 1] }));
  for (let i = 0; i < assigned.length; i += CONCURRENCY) {
    await Promise.all(assigned.slice(i, i + CONCURRENCY).map(({ nodeId, direction }) => generateOne(env, nodeId, direction, job)));
  }
}

const parsePrompt = (v: unknown) => { const p = typeof v === 'string' ? v.trim() : ''; if (!p) throw new HttpError(400, 'prompt required', 'PROMPT_REQUIRED'); return p; };
const parseCount = (v: unknown) => { if (!Number.isInteger(v) || Number(v) < 1 || Number(v) > 5) throw new HttpError(400, 'count must be an integer between 1 and 5', 'INVALID_COUNT'); return Number(v); };
const parseNodeIds = (v: unknown, count: number) => {
  if (!Array.isArray(v) || v.length !== count || !v.every((id) => typeof id === 'string' && id)) throw new HttpError(400, 'nodeIds must be an array of ids matching count', 'INVALID_NODE_IDS');
  return v as string[];
};

// ── Router ────────────────────────────────────────────────────────────────────

type Handler = (c: { req: Request; env: Env; ctx: Ctx; params: Record<string, string>; url: URL }) => Promise<Response> | Response;
const routes: Array<{ method: string; parts: string[]; handler: Handler }> = [];
const on = (method: string, template: string, handler: Handler) => routes.push({ method, parts: template.split('/').filter(Boolean), handler });
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const text = (body: string, contentType: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': contentType, ...headers } });

on('GET', '/api/health', () => json({ service: 'ramify', version: '0.2.0', capabilities: ['batch-nodes', 'optimistic-concurrency', 'server-seq', 'direct-sql', 'direct-artifacts', 'theme-settings', 'locale-settings', 'ai-generate'] }));

on('GET', '/api/settings', async ({ env }) => json(await settings.read(env)));
on('PUT', '/api/settings/theme', async ({ req, env }) => {
  const { theme } = await readJson(req);
  if (!isThemePreference(theme)) throw new HttpError(400, 'theme must be light, dark, or system', 'INVALID_THEME');
  return json(await settings.write(env, 'theme', theme));
});
on('PUT', '/api/settings/locale', async ({ req, env }) => {
  const { locale } = await readJson(req);
  if (!isLocale(locale)) throw new HttpError(400, 'locale must be zh-CN, en, ja, es, or de', 'INVALID_LOCALE');
  return json(await settings.write(env, 'locale', locale));
});

on('GET', '/api/projects', async ({ env }) => json(await projects.list(env)));
on('GET', '/api/projects/version', async ({ env }) => json({ version: await projects.version(env) }));
on('POST', '/api/projects', async ({ req, env }) => json(await projects.create(env, await readJson(req))));
on('PUT', '/api/projects/:projectId', async ({ req, env, params }) => json(await projects.rename(env, params.projectId, await readJson(req))));
on('DELETE', '/api/projects/:projectId', async ({ env, params }) => json(await projects.delete(env, params.projectId)));
on('GET', '/api/projects/:projectId/tree', async ({ env, params }) => json(await projects.tree(env, params.projectId)));
on('GET', '/api/projects/:projectId/version', async ({ env, params }) => json({ version: await projects.treeVersion(env, params.projectId) }));

on('POST', '/api/projects/:projectId/nodes', async ({ req, env, params }) => json(await nodes.create(env, params.projectId, await readJson(req))));
on('POST', '/api/projects/:projectId/nodes/batch', async ({ req, env, params }) => json(await nodes.createBatch(env, params.projectId, await readJson(req))));
on('PUT', '/api/nodes/:nodeId', async ({ req, env, params }) => json(await nodes.update(env, params.nodeId, await readJson(req))));
on('PUT', '/api/nodes/:nodeId/artifact', async ({ req, env, params }) => json(await nodes.updateArtifact(env, params.nodeId, await readJson(req))));
on('PUT', '/api/nodes/:nodeId/artifact/error', async ({ req, env, params }) => json(await nodes.markArtifactError(env, params.nodeId, await readJson(req))));
on('DELETE', '/api/nodes/:nodeId/artifact', async ({ env, params }) => json(await nodes.clearArtifact(env, params.nodeId)));
on('DELETE', '/api/nodes/:nodeId', async ({ env, params }) => json(await nodes.delete(env, params.nodeId)));
on('GET', '/api/nodes/:nodeId/html', async ({ env, params, url }) => {
  const revision = url.searchParams.get('revision');
  return text(await nodes.html(env, params.nodeId), 'text/html; charset=utf-8', { 'cache-control': revision ? 'private, max-age=31536000, immutable' : 'no-store' });
});
on('GET', '/api/nodes/:nodeId/content', async ({ env, params }) => {
  const node = await requireNode(env, params.nodeId);
  return json({ content: node.type === 'text' || node.type === 'error' ? node.content : null });
});
on('GET', '/api/nodes/:nodeId/artifact/source', async ({ env, params }) => json(await nodes.artifactSource(env, params.nodeId)));
on('GET', '/api/nodes/:nodeId/artifact', async ({ env, params }) => {
  const node = await nodes.requireArtifactNode(env, params.nodeId);
  const rel = node.content as string;
  const mime = artifacts.mime(rel, node.type as ArtifactType);
  const filename = rel.split('/').pop() || 'artifact';
  const headers = { 'content-type': mime, 'cache-control': 'no-store', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}` };
  if (mime.startsWith('text/') || mime.startsWith('image/svg+xml')) return new Response(await artifacts.readText(env, rel), { headers });
  const bytes = Uint8Array.from(atob(await artifacts.readBase64(env, rel)), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers });
});

on('POST', '/api/projects/:projectId/generate', async ({ req, env, ctx, params }) => {
  await requireProject(env, params.projectId);
  const body = await readJson(req);
  const prompt = parsePrompt(body.prompt);
  const count = parseCount(body.count);
  const nodeIds = parseNodeIds(body.nodeIds, count);
  for (const id of nodeIds) if (!(await findNodeInProject(env, id, params.projectId))) throw new HttpError(404, `node ${id} not found in project`, 'NODE_NOT_FOUND');
  ctx.waitUntil(runGeneration(env, { kind: 'root', prompt, count, nodeIds }));
  return json({ accepted: true, nodeIds }, 202);
});
on('POST', '/api/nodes/:nodeId/branch', async ({ req, env, ctx, params }) => {
  const parent = await requireNode(env, params.nodeId);
  const body = await readJson(req);
  const prompt = parsePrompt(body.prompt);
  const count = parseCount(body.count);
  const nodeIds = parseNodeIds(body.nodeIds, count);
  for (const id of nodeIds) if (!(await findNodeInProject(env, id, parent.project_id))) throw new HttpError(404, `node ${id} not found in project`, 'NODE_NOT_FOUND');
  let parentContent = '';
  try { parentContent = String((await nodes.artifactSource(env, parent.id)).source ?? ''); } catch { parentContent = String(parent.content || ''); }
  ctx.waitUntil(runGeneration(env, { kind: 'branch', prompt, count, nodeIds, parent: { type: parent.type, content: parentContent } }));
  return json({ accepted: true, nodeIds }, 202);
});

const match = (parts: string[], path: string[]) => {
  if (parts.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(path[i]);
    else if (parts[i] !== path[i]) return null;
  }
  return params;
};

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      await ensure(env);
      const path = url.pathname.split('/').filter(Boolean);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const route of routes) {
        if (route.method !== method) continue;
        const params = match(route.parts, path);
        if (!params) continue;
        return await route.handler({ req, env, ctx, params, url });
      }
      return json({ error: 'not found', code: 'ROUTE_NOT_FOUND' }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) env.log?.('[ramify]', String(error instanceof Error ? error.stack || error.message : error));
      return json({ error: error instanceof Error ? error.message : String(error), code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' }, status);
    }
  },
};
