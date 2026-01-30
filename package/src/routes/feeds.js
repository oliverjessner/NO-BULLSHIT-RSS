import express from 'express';
import { all, get, run } from '../db.js';
import { checkUrlReachable, isValidUrl } from '../utils/validation.js';
import Parser from 'rss-parser';
import { fetchSiteLogo } from '../services/logo.js';
import { publish } from '../services/events.js';

const router = express.Router();
const parser = new Parser({ timeout: 8000 });

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

router.get('/', asyncHandler(async (req, res) => {
  const feeds = await all('SELECT * FROM feeds ORDER BY id DESC');
  const mapped = feeds.map((feed) => {
    const logoDataUrl = feed.logo && feed.logoMime
      ? `data:${feed.logoMime};base64,${feed.logo.toString('base64')}`
      : null;
    const { logo, logoMime, ...rest } = feed;
    return { ...rest, logoDataUrl };
  });
  res.json(mapped);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, websiteUrl, feedUrl } = req.body || {};

  if (!name || !websiteUrl || !feedUrl) {
    return res.status(400).json({ error: 'name, websiteUrl, and feedUrl are required' });
  }
  if (!isValidUrl(websiteUrl) || !isValidUrl(feedUrl)) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const reachable = await checkUrlReachable(feedUrl);
  if (!reachable) {
    return res.status(400).json({ error: 'Feed URL not reachable' });
  }

  let logoBuffer = null;
  let logoMime = null;
  const logo = await fetchSiteLogo(websiteUrl);
  if (logo) {
    logoBuffer = logo.buffer;
    logoMime = logo.mime;
  }

  const result = await run(
    `INSERT INTO feeds (name, websiteUrl, feedUrl, logo, logoMime, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [name, websiteUrl, feedUrl, logoBuffer, logoMime]
  );
  const feed = await get('SELECT * FROM feeds WHERE id = ?', [result.lastID]);
  const logoDataUrl = feed.logo && feed.logoMime
    ? `data:${feed.logoMime};base64,${feed.logo.toString('base64')}`
    : null;
  const { logo: logoBlob, logoMime: logoMimeType, ...rest } = feed;
  publish('feeds.updated', { id: feed.id });
  res.status(201).json({ ...rest, logoDataUrl });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, websiteUrl, feedUrl } = req.body || {};

  if (!name || !websiteUrl || !feedUrl) {
    return res.status(400).json({ error: 'name, websiteUrl, and feedUrl are required' });
  }
  if (!isValidUrl(websiteUrl) || !isValidUrl(feedUrl)) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const reachable = await checkUrlReachable(feedUrl);
  if (!reachable) {
    return res.status(400).json({ error: 'Feed URL not reachable' });
  }

  const existing = await get('SELECT * FROM feeds WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Feed not found' });

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
    [name, websiteUrl, feedUrl, logoBuffer, logoMime, id]
  );

  if (result.changes === 0) return res.status(404).json({ error: 'Feed not found' });
  const feed = await get('SELECT * FROM feeds WHERE id = ?', [id]);
  const logoDataUrl = feed.logo && feed.logoMime
    ? `data:${feed.logoMime};base64,${feed.logo.toString('base64')}`
    : null;
  const { logo: logoBlob, logoMime: logoMimeType, ...rest } = feed;
  publish('feeds.updated', { id: feed.id });
  res.json({ ...rest, logoDataUrl });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await run('DELETE FROM feeds WHERE id = ?', [id]);
  if (result.changes === 0) return res.status(404).json({ error: 'Feed not found' });
  publish('feeds.updated', { id });
  res.status(204).end();
}));

router.get('/test/url', asyncHandler(async (req, res) => {
  const { url } = req.query || {};
  if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL format' });

  try {
    const feed = await parser.parseURL(url);
    const titles = (feed.items || []).slice(0, 3).map((item) => item.title).filter(Boolean);
    res.json({ title: feed.title || null, itemCount: (feed.items || []).length, sampleTitles: titles });
  } catch (err) {
    res.status(400).json({ error: 'Feed not reachable or invalid RSS' });
  }
}));

export default router;
