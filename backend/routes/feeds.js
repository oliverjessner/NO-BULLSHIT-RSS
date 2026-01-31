import express from 'express';
import { all, get, run } from '../database/datenbank.js';
import { checkUrlReachable, isValidUrl } from '../utils/validation.js';
import Parser from 'rss-parser';
import { fetchSiteLogo } from '../services/logo.js';
import { publish } from '../services/events.js';

const router = express.Router();
const parser = new Parser({ timeout: 8000 });

router.get('/', async (_, res) => {
    const feeds = await all('SELECT * FROM feeds ORDER BY id DESC');
    const mapped = feeds.map(feed => {
        const logoDataUrl =
            feed.logo && feed.logoMime ? `data:${feed.logoMime};base64,${feed.logo.toString('base64')}` : null;
        const { logo, logoMime, ...rest } = feed;
        return { ...rest, logoDataUrl };
    });

    return res.json(mapped);
});

router.post('/', async ({ body: { name, websiteUrl, feedUrl } }, res) => {
    const reachable = await checkUrlReachable(feedUrl);
    const logo = await fetchSiteLogo(websiteUrl);
    let logoBuffer = null;
    let logoMime = null;

    if (!name || !websiteUrl || !feedUrl) {
        return res.status(400).json({ error: 'name, websiteUrl, and feedUrl are required' });
    }
    if (!isValidUrl(websiteUrl) || !isValidUrl(feedUrl)) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!reachable) {
        return res.status(400).json({ error: 'Feed URL not reachable' });
    }

    if (logo) {
        logoBuffer = logo.buffer;
        logoMime = logo.mime;
    }

    const result = await run(
        `INSERT INTO feeds (name, websiteUrl, feedUrl, logo, logoMime, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [name, websiteUrl, feedUrl, logoBuffer, logoMime],
    );
    const feed = await get('SELECT * FROM feeds WHERE id = ?', [result.lastID]);
    const logoDataUrl =
        feed.logo && feed.logoMime ? `data:${feed.logoMime};base64,${feed.logo.toString('base64')}` : null;
    const { logo: logoBlob, logoMime: logoMimeType, ...rest } = feed;

    publish('feeds.updated', { id: feed.id });
    return res.status(201).json({ ...rest, logoDataUrl });
});

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, websiteUrl, feedUrl } = req.body || {};
    const reachable = await checkUrlReachable(feedUrl);
    const existing = await get('SELECT * FROM feeds WHERE id = ?', [id]);

    if (!name || !websiteUrl || !feedUrl) {
        return res.status(400).json({ error: 'name, websiteUrl, and feedUrl are required' });
    }
    if (!isValidUrl(websiteUrl) || !isValidUrl(feedUrl)) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!reachable) {
        return res.status(400).json({ error: 'Feed URL not reachable' });
    }
    if (!existing) {
        return res.status(404).json({ error: 'Feed not found' });
    }

    let logoBuffer = existing.logo;
    let logoMime = existing.logoMime;

    if (!existing.logo || existing.websiteUrl !== websiteUrl) {
        const logo = await fetchSiteLogo(websiteUrl);
        if (logo) {
            logoBuffer = logo.buffer;
            logoMime = logo.mime;
        }
    }

    const result = await run(
        `UPDATE feeds
     SET name = ?, websiteUrl = ?, feedUrl = ?, logo = ?, logoMime = ?, updatedAt = datetime('now')
     WHERE id = ?`,
        [name, websiteUrl, feedUrl, logoBuffer, logoMime, id],
    );

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Feed not found' });
    }

    const feed = await get('SELECT * FROM feeds WHERE id = ?', [id]);
    const logoDataUrl =
        feed.logo && feed.logoMime ? `data:${feed.logoMime};base64,${feed.logo.toString('base64')}` : null;
    const { logo: logoBlob, logoMime: logoMimeType, ...rest } = feed;

    publish('feeds.updated', { id: feed.id });
    res.json({ ...rest, logoDataUrl });
});

router.delete('/:id', async ({ params: { id } }, res) => {
    const result = await run('DELETE FROM feeds WHERE id = ?', [id]);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Feed not found' });
    }

    publish('feeds.updated', { id });
    return res.status(204).end();
});

router.get('/test/url', async ({ query: { url } }, res) => {
    if (!isValidUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    try {
        const feed = await parser.parseURL(url);
        const titles = (feed.items || [])
            .slice(0, 3)
            .map(item => item.title)
            .filter(Boolean);

        return res.json({ title: feed.title || null, itemCount: (feed.items || []).length, sampleTitles: titles });
    } catch (err) {
        return res.status(400).json({ error: 'Feed not reachable or invalid RSS' });
    }
});

export default router;
