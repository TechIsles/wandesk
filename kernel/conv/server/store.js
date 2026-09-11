// Conversation store: data access over the kernel database (schema in kernel/data/schema.sql).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file) {
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    // Tables are defined once, in kernel/data/schema.sql; the kernel has created them before this store opens.
    db.exec('PRAGMA optimize;');
    return db;
}

export function createStore(db) {
    const list = db.prepare(`SELECT id, title, workdir, pinned, created_at, updated_at
        FROM conversations ORDER BY pinned DESC, updated_at DESC`);
    const get = db.prepare('SELECT * FROM conversations WHERE id = ?');
    const insert = db.prepare(`INSERT INTO conversations
        (id, title, workdir, context_json, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, ?)`);
    const remove = db.prepare('DELETE FROM conversations WHERE id = ?');
    // messages / compactions are keyed by thread, not by conversation, so there is no cascade: a conversation deletes its own thread
    const removeMessages = db.prepare('DELETE FROM messages WHERE thread_id = ?');
    const removeCompactions = db.prepare('DELETE FROM compactions WHERE thread_id = ?');
    const pageLatest = db.prepare(`SELECT id, seq, item_json, created_at FROM messages
        WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`);
    const pageBefore = db.prepare(`SELECT id, seq, item_json, created_at FROM messages
        WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`);
    const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE thread_id = ?');
    const addMessage = db.prepare(`INSERT INTO messages (thread_id, seq, item_json, created_at)
        VALUES (?, ?, ?, ?)`);
    const updateContext = db.prepare(`UPDATE conversations
        SET context_json = ?, usage_json = ?, updated_at = ? WHERE id = ?`);
    const updateTitle = db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?');
    const updatePinned = db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?');
    const updateWorkdir = db.prepare('UPDATE conversations SET workdir = ? WHERE id = ?');
    const touchRow = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
    const listSettings = db.prepare('SELECT key, value FROM settings');
    const latestMessageSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE thread_id = ?');
    const lastCompaction = db.prepare('SELECT end_seq FROM compactions WHERE thread_id = ? ORDER BY end_seq DESC LIMIT 1');
    const addCompaction = db.prepare(`INSERT INTO compactions
        (thread_id, start_seq, end_seq, summary, kind, tokens, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const now = () => new Date().toISOString();
    const parseConversation = (row) => row && ({
        ...row,
        context: JSON.parse(row.context_json || '[]'),
        usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    });

    return {
        getSettings: () => Object.fromEntries(listSettings.all().map((row) => [row.key, row.value])),
        latestMessageSeq: (id) => Number(latestMessageSeq.get(id).seq) || 0,
        lastCompactionEnd: (id) => Number(lastCompaction.get(id)?.end_seq) || 0,
        appendCompaction(id, { startSeq, endSeq, summary, kind, tokens = 0 }) {
            addCompaction.run(id, startSeq, endSeq, summary, kind, tokens, now());
        },
        listConversations: () => list.all(),
        getConversation: (id) => parseConversation(get.get(id)),
        createConversation({ id, title, workdir }) {
            const at = now();
            insert.run(id, title, workdir, at, at);
            return parseConversation(get.get(id));
        },
        deleteConversation(id) {
            removeMessages.run(id);
            removeCompactions.run(id);
            return remove.run(id).changes > 0;
        },

        /** The most recent page (returned in ascending seq order); pass `before` as the previous page's earliest seq to page further back. */
        listMessages(id, { before = 0, limit = 60 } = {}) {
            const rows = before > 0 ? pageBefore.all(id, before, limit + 1) : pageLatest.all(id, limit + 1);
            const hasMore = rows.length > limit;
            const page = rows.slice(0, limit).reverse();
            return {
                messages: page.map((row) => ({ seq: row.seq, item: JSON.parse(row.item_json), createdAt: row.created_at })),
                hasMore,
            };
        },

        append(id, item) {
            const seq = Number(nextSeq.get(id).seq);
            const at = now();
            addMessage.run(id, seq, JSON.stringify(item), at);
            touchRow.run(at, id);
            return { seq, item, createdAt: at };
        },
        saveContext(id, context, usage) {
            updateContext.run(JSON.stringify(context), usage ? JSON.stringify(usage) : null, now(), id);
        },
        setTitle(id, title) { updateTitle.run(title, now(), id); },
        /** Pinning doesn't touch updated_at —— after pinning, ordering still follows last activity, so it doesn't jump to the top of the recent group. */
        setPinned(id, pinned) { updatePinned.run(pinned ? 1 : 0, id); },
        setWorkdir(id, workdir) { updateWorkdir.run(workdir, id); },
    };
}
