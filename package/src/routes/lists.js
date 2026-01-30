import express from 'express';
import { all, get, run } from '../db.js';
import { publish } from '../services/events.js';

const router = express.Router();

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

router.get('/', asyncHandler(async (req, res) => {
  const lists = await all('SELECT * FROM lists ORDER BY id DESC');
  res.json(lists);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, description, color } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const result = await run(
    `INSERT INTO lists (name, description, color, createdAt, updatedAt)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [name.trim(), description ? description.trim() : null, color || '#1d1d1f']
  );

  const list = await get('SELECT * FROM lists WHERE id = ?', [result.lastID]);
  publish('lists.updated', { id: list.id });
  res.status(201).json(list);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, color } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const result = await run(
    `UPDATE lists
     SET name = ?, description = ?, color = ?, updatedAt = datetime('now')
     WHERE id = ?`,
    [name.trim(), description ? description.trim() : null, color || '#1d1d1f', id]
  );

  if (result.changes === 0) {
    return res.status(404).json({ error: 'List not found' });
  }

  const list = await get('SELECT * FROM lists WHERE id = ?', [id]);
  publish('lists.updated', { id: list.id });
  res.json(list);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await run('DELETE FROM lists WHERE id = ?', [id]);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'List not found' });
  }
  publish('lists.updated', { id });
  res.status(204).end();
}));

router.post('/:id/items', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { articleId } = req.body || {};

  if (!articleId) {
    return res.status(400).json({ error: 'articleId is required' });
  }

  await run(
    `INSERT OR IGNORE INTO list_items (listId, articleId, createdAt)
     VALUES (?, ?, datetime('now'))`,
    [id, articleId]
  );

  publish('lists.items.updated', { listId: id, articleId });
  res.status(201).json({ ok: true });
}));

router.delete('/:id/items/:articleId', asyncHandler(async (req, res) => {
  const { id, articleId } = req.params;
  const result = await run(
    'DELETE FROM list_items WHERE listId = ? AND articleId = ?',
    [id, articleId]
  );
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Item not found' });
  }
  publish('lists.items.updated', { listId: id, articleId });
  res.status(204).end();
}));

export default router;
