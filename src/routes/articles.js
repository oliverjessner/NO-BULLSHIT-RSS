import express from 'express';
import { all } from '../db.js';
import { logInfo } from '../utils/logger.js';

const router = express.Router();

router.get('/', async ({ query: { feedId, source, listId, query, limit = 100 } }, res) => {
    const params = [];
    const whereParts = [];
    const like = `%${query}%`;

    if (feedId) {
        whereParts.push('feeds.id = ?');
        params.push(feedId);
    } else if (source) {
        whereParts.push('feeds.name = ?');
        params.push(source);
    }
    if (listId) {
        whereParts.push('list_items.listId = ?');
        params.push(listId);
    }
    if (query) {
        logInfo('Search query', { query });
        whereParts.push('(articles.title LIKE ? OR articles.teaser LIKE ? OR feeds.name LIKE ?)');
        params.push(like, like, like);
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const sql = `
    SELECT articles.*, feeds.name as sourceName, feeds.logo as sourceLogo, feeds.logoMime as sourceLogoMime
    FROM articles
    JOIN feeds ON feeds.id = articles.feedId
    LEFT JOIN list_items ON list_items.articleId = articles.id
    ${where}
    ORDER BY datetime(articles.publishedAt) DESC, articles.id DESC
    LIMIT ?
  `;
    params.push(Number(limit) || 100);

    const rows = await all(sql, params);
    const mapped = rows.map(row => {
        const logoDataUrl =
            row.sourceLogo && row.sourceLogoMime
                ? `data:${row.sourceLogoMime};base64,${row.sourceLogo.toString('base64')}`
                : null;
        const { sourceLogo, sourceLogoMime, ...rest } = row;

        return { ...rest, sourceLogoDataUrl: logoDataUrl };
    });

    return res.json(mapped);
});

router.get('/:id/lists', async ({ params: { id } }, res) => {
    const rows = await all(
        `SELECT lists.id, lists.name, lists.color
     FROM list_items
     JOIN lists ON lists.id = list_items.listId
     WHERE list_items.articleId = ?`,
        [id],
    );

    return res.json(rows);
});

export default router;
