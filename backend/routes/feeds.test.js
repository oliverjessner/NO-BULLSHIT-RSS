import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import express from 'express';

const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-feeds-'));
process.env.DB_PATH = path.join(testDirectory, 'feeds.db');

const database = await import('../database/datenbank.js');
const { createFeedRecord, updateFeedRecord, createFeedsRouter } = await import('./feeds.js');
const { updateAllFeeds } = await import('../services/fetcher.js');

await database.initSchema();

test.beforeEach(() => database.exec('DELETE FROM digest_generations; DELETE FROM digest_period_articles; DELETE FROM sources;'));

async function fixture(t, handler) {
    const app = express();
    app.use(express.json());
    app.use('/api/feeds', createFeedsRouter({ fetchLogo: async () => null }));
    app.use(handler);
    const server = createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('keeps feed names independent when feeds share a website source', async () => {
    const websiteUrl = 'https://www.businessinsider.de/';
    const techId = await createFeedRecord({
        name: 'Business Insider Tech',
        websiteUrl,
        feedUrl: 'https://www.businessinsider.de/tech/feed/',
    });
    const startupId = await createFeedRecord({
        name: 'Business Insider Startups',
        websiteUrl,
        feedUrl: 'https://www.businessinsider.de/wirtschaft/startups/feed/',
    });

    assert.equal(Number((await database.get('SELECT COUNT(*) AS count FROM sources')).count), 1);
    assert.deepEqual(
        await database.all('SELECT id, name FROM feeds ORDER BY id'),
        [
            { id: techId, name: 'Business Insider Tech' },
            { id: startupId, name: 'Business Insider Startups' },
        ],
    );

    await updateFeedRecord({
        id: techId,
        name: 'BI Tech',
        websiteUrl,
        feedUrl: 'https://www.businessinsider.de/tech/feed/',
    });

    assert.deepEqual(
        await database.all('SELECT id, name FROM feeds ORDER BY id'),
        [
            { id: techId, name: 'BI Tech' },
            { id: startupId, name: 'Business Insider Startups' },
        ],
    );
});

test('testing, adding, editing and scheduled import share compressed RSS and character decoding', async t => {
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel>
        <title>Märkte</title><link>https://example.test</link><description>News</description>
        <item><guid>shared-reader</guid><title>Neue Größe</title><link>https://example.test/article</link></item>
        </channel></rss>`;
    let rssRequests = 0;
    const base = await fixture(t, (req, res) => {
        if (req.path === '/feed') return res.redirect('/rss');
        rssRequests += 1;
        res.set({ 'Content-Type': 'application/rss+xml', 'Content-Encoding': 'gzip' });
        return res.end(gzipSync(Buffer.from(xml, 'latin1')));
    });
    const feedUrl = `${base}/feed`;
    const preview = await fetch(`${base}/api/feeds/test/url?${new URLSearchParams({ url: feedUrl })}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { title: 'Märkte', itemCount: 1, sampleTitles: ['Neue Größe'] });

    const body = { name: 'Test feed', websiteUrl: base, feedUrl };
    const created = await fetch(`${base}/api/feeds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(created.status, 201);
    const feed = await created.json();
    const updated = await fetch(`${base}/api/feeds/${feed.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, name: 'Updated feed' }),
    });
    assert.equal(updated.status, 200);
    await updateAllFeeds({ refreshLogos: async () => {}, notify: async () => {} });
    assert.equal(rssRequests, 4);
    assert.deepEqual(await database.all('SELECT title, url FROM articles'), [
        { title: 'Neue Größe', url: 'https://example.test/article' },
    ]);
});

test('testing, adding and editing expose the same HTTP restriction without saving an invalid feed', async t => {
    let requests = 0;
    const base = await fixture(t, (_req, res) => {
        requests += 1;
        res.status(429).type('html').end('<html><title>Vercel Security Checkpoint</title></html>');
    });
    const id = await createFeedRecord({ name: 'Existing', websiteUrl: base, feedUrl: `${base}/original` });
    const body = { name: 'Denied', websiteUrl: base, feedUrl: `${base}/blocked` };
    const results = [
        await fetch(`${base}/api/feeds/test/url?${new URLSearchParams({ url: body.feedUrl })}`),
        await fetch(`${base}/api/feeds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        await fetch(`${base}/api/feeds/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ];
    for (const response of results) {
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'Feed server returned HTTP 429 (rate limit or automated-access protection)' });
    }
    assert.equal(requests, 3);
    assert.deepEqual(await database.all('SELECT name, feedUrl FROM feeds'), [{ name: 'Existing', feedUrl: `${base}/original` }]);
});

test.after(async () => {
    await database.closeDatabase();
    await rm(testDirectory, { recursive: true, force: true });
});
