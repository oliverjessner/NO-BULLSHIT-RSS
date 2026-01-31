import express from 'express';
import { all, get, run } from '../database/datenbank.js';
import { publish } from '../services/events.js';

const router = express.Router();

router.get('/', async (_, res) => {
    const lists = await all('SELECT * FROM lists ORDER BY id DESC');
    return res.json(lists);
});

router.post('/', async ({ body = {} }, res) => {
    const { name, description, color = '#1d1d1f' } = body;
    const desc = description ? description.trim() : null;
    const values = [name.trim(), desc, color];
    const sql = `INSERT INTO lists (name, description, color, createdAt, updatedAt) VALUES (?, ?, ?, datetime('now'), datetime('now'))`;

    if (!name) {
        return res.status(400).json({ error: 'name is required' });
    }

    const result = await run(sql, values);
    const list = await get('SELECT * FROM lists WHERE id = ?', [result.lastID]);

    publish('lists.updated', { id: list.id });
    return res.status(201).json(list);
});

router.put('/:id', async ({ params: { id }, body }, res) => {
    const { name, description, color = '#1d1d1f' } = body || {};
    const desc = description ? description.trim() : null;
    const values = [name.trim(), desc, color, id];
    const sql = `UPDATE lists
     SET name = ?, description = ?, color = ?, updatedAt = datetime('now')
     WHERE id = ?`;

    if (!name) {
        return res.status(400).json({ error: 'name is required' });
    }

    const result = await run(sql, values);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'List not found' });
    }

    const list = await get('SELECT * FROM lists WHERE id = ?', [id]);
    publish('lists.updated', { id: list.id });
    res.json(list);
});

router.delete('/:id', async ({ params: { id } }, res) => {
    const result = await run('DELETE FROM lists WHERE id = ?', [id]);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'List not found' });
    }

    publish('lists.updated', { id });
    return res.status(204).end();
});

router.post('/:id/items', async ({ params: { id }, body: { articleId } }, res) => {
    if (!articleId) {
        return res.status(400).json({ error: 'articleId is required' });
    }

    await run(
        `INSERT OR IGNORE INTO list_items (listId, articleId, createdAt)
     VALUES (?, ?, datetime('now'))`,
        [id, articleId],
    );

    publish('lists.items.updated', { listId: id, articleId });
    return es.status(201).json({ ok: true });
});

router.delete('/:id/items/:articleId', async ({ params: { id, articleId } }, res) => {
    const result = await run('DELETE FROM list_items WHERE listId = ? AND articleId = ?', [id, articleId]);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Item not found' });
    }

    publish('lists.items.updated', { listId: id, articleId });
    return res.status(204).end();
});

export default router;
