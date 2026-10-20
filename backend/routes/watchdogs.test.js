import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-watchdog-api-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const db = await import('../database/datenbank.js');
const { default: router } = await import('./watchdogs.js');
const { processWatchdogArticles } = await import('../services/watchdogs.js');
const { subscribe } = await import('../services/events.js');
const { watchdogDateBounds } = await import('../services/watchdog-filters.js');
await db.initSchema();
await db.exec(`INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt) VALUES ('Test', 'https://example.test', 'https://example.test/', datetime('now'), datetime('now'));
    INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt) VALUES (1, 'Test', 'https://example.test/feed', datetime('now'), datetime('now'));`);
const app = express(); app.use(express.json()); app.use('/api/watchdogs', router);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/watchdogs`;
async function request(endpoint = '', method = 'GET', body) {
    const response = await fetch(base + endpoint, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

test('CRUD, match read/archive filters and SSE updates use the same persisted state', async () => {
    const events = []; const unsubscribe = subscribe(event => events.push(event));
    try {
        const created = await request('', 'POST', { name: 'AI', includeAny: ['OpenAI'], includeAll: ['report'], exclude: ['sponsored'], feedIds: [1] });
        assert.equal(created.status, 201);
        const id = created.body.watchdog.id;
        await db.run(`INSERT INTO articles (feedId, externalId, title, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
            VALUES (1, 'api', 'OpenAI report', 'test', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`);
        await processWatchdogArticles();
        let list = await request();
        assert.equal(list.body.unreadCount, 1);
        let matches = await request(`/matches?status=unread&watchdogId=${id}`);
        assert.equal(matches.body.matches.length, 1);
        const matchId = matches.body.matches[0].id;
        assert.equal((await request(`/matches/${matchId}`)).body.title, 'OpenAI report');
        assert.equal((await request(`/matches/${matchId}`, 'PATCH', { read: true, archived: true })).status, 200);
        assert.equal((await request('/matches?status=unread')).body.matches.length, 0);
        assert.equal((await request('/matches?status=read&archived=true')).body.matches.length, 1);
        assert.equal((await request()).body.unreadCount, 0);
        assert.equal((await request(`/matches/${matchId}`, 'PATCH', { read: false, archived: false })).status, 200);
        assert.equal((await request(`/${id}`, 'PATCH', { enabled: false, name: 'Paused AI' })).body.watchdog.enabled, false);
        assert.equal((await request('/notifications')).body.enabled, false);
        assert.equal((await request('/notifications', 'PATCH', { enabled: true })).body.enabled, true);
        assert.equal((await request(`/${id}`, 'DELETE')).status, 204);
        assert.equal((await request(`/matches/${matchId}`)).status, 404);
        assert.equal((await request()).body.watchdogs.length, 0);
        assert.ok(events.some(event => event.event === 'watchdogs.updated' && event.data.action === 'matched'));
        assert.ok(events.some(event => event.data.action === 'match-state'));
    } finally { unsubscribe(); }
});

test('validates request bodies and filters without accepting injected identifiers or rule fields', async () => {
    for (const body of [{ name: 'No includes' }, { name: ' ', includeAny: ['test'] }, { name: 'Invalid', includeAny: [''] },
        { name: 'Invalid', includeAny: ['test'], feedIds: [9999] }, { name: 'Invalid', includeAny: ['test'], startArticleId: 0 }]) {
        assert.equal((await request('', 'POST', body)).status, 400);
    }
    for (const endpoint of ['/matches?status=invalid', '/matches?watchdogId=1%20OR%201=1', '/matches?before=-1', '/matches?archived=no', '/matches?extra=x', '/matches?range=forever', '/matches?asOf=invalid', '/export?limit=251', '/export?range=forever', '/export?asOf=invalid']) {
        assert.equal((await request(endpoint)).status, 400);
    }
    assert.equal((await request('/matches/1', 'PATCH', {})).status, 400);
    assert.equal((await request('/matches/1', 'PATCH', { read: 'true' })).status, 400);
    assert.equal((await request('/notifications', 'PATCH', { enabled: 'true' })).status, 400);
    assert.equal((await request('/9999', 'PATCH', { enabled: true })).status, 404);
    assert.equal((await request('/9999', 'DELETE')).status, 404);
});

test('rolling time windows clamp calendar boundaries and combine with read/archive/watchdog filters', async () => {
    assert.deepEqual(watchdogDateBounds('month', Date.parse('2024-03-31T12:00:00Z')), { from: '2024-02-29T12:00:00.000Z', to: '2024-03-31T12:00:00.000Z' });
    assert.equal(watchdogDateBounds('year', Date.parse('2024-02-29T12:00:00Z')).from, '2023-02-28T12:00:00.000Z');
    const asOf = Date.parse('2026-10-20T12:00:00Z');
    const created = await request('', 'POST', { name: 'Time windows', includeAny: ['Time fixture'] });
    const id = created.body.watchdog.id;
    try {
        for (const [index, date] of ['2026-10-20T12:00:01Z', '2026-10-20T11:00:00Z', '2026-10-19T12:00:00Z', '2026-10-19T11:59:59Z', '2026-10-13T12:00:00Z', '2026-09-20T12:00:00Z', '2025-10-20T12:00:00Z', '2025-10-20T11:59:59Z'].entries()) {
            await db.run(`INSERT INTO articles (feedId, externalId, title, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
                VALUES (1, ?, 'Time fixture', 'test', ?, datetime('now'), datetime('now'), datetime('now'))`, [`time-${index}`, date]);
        }
        await processWatchdogArticles();
        for (const [range, count] of [['24h', 2], ['7d', 4], ['month', 5], ['year', 6], ['all', 8]]) {
            const params = `watchdogId=${id}&range=${range}&asOf=${asOf}`;
            assert.equal((await request(`/matches?${params}`)).body.matches.length, count, range);
            assert.equal((await request(`/export?${params}`)).body.length, count, `Export: ${range}`);
        }
        const recent = (await request(`/matches?watchdogId=${id}&range=24h&asOf=${asOf}`)).body.matches[0];
        await request(`/matches/${recent.id}`, 'PATCH', { read: true, archived: true });
        const params = `watchdogId=${id}&range=24h&asOf=${asOf}&status=read&archived=true`;
        assert.equal((await request(`/matches?${params}`)).body.matches.length, 1);
        assert.deepEqual((await request(`/export?${params}`)).body.map(article => article.id), [recent.articleId]);
        assert.equal((await request(`/matches?${params}&before=${recent.id}`)).body.matches.length, 0);
    } finally { await request(`/${id}`, 'DELETE'); }
});

test('export pages use canonical Feed articles, include dismissed matches, and deduplicate overlapping watchdogs', async () => {
    const first = (await request('', 'POST', { name: 'Export one', includeAny: ['Export fixture'] })).body.watchdog.id;
    const second = (await request('', 'POST', { name: 'Export two', includeAny: ['Export fixture'] })).body.watchdog.id;
    try {
        await db.transaction(async () => {
            for (let index = 0; index < 255; index++) await db.run(`INSERT INTO articles
                (feedId, externalId, title, teaser, url, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
                VALUES (1, ?, ?, 'Summary', ?, 'test', '2026-10-20 10:00:00', datetime('now'), datetime('now'), datetime('now'))`,
            [`export-${index}`, `Export fixture ${index}`, `https://example.test/export/${index}`]);
        });
        await processWatchdogArticles();
        const page = (await request(`/export?watchdogId=${first}&limit=250`)).body;
        assert.equal(page.length, 250);
        const last = page.at(-1);
        const next = (await request(`/export?watchdogId=${first}&limit=250&cursorId=${last.id}&cursorPublishedAt=${encodeURIComponent(last.publishedAt)}`)).body;
        assert.equal(next.length, 5);
        assert.equal(new Set([...page, ...next].map(article => article.id)).size, 255);
        assert.equal((await request('/export?limit=250')).body.length, 250);
        const { queryArticles } = await import('../services/article-queries.js');
        const feed = await queryArticles({ activeOnly: false, limit: 1000, maxLimit: 1000 }, { all: db.all });
        assert.deepEqual(page, feed.filter(article => article.title.startsWith('Export fixture')).slice(0, 250));
        await db.run("INSERT INTO article_state (articleId, dismissedAt, createdAt, updatedAt) VALUES (?, datetime('now'), datetime('now'), datetime('now'))", [page[0].id]);
        assert.equal((await request(`/export?watchdogId=${first}&limit=1`)).body[0].id, page[0].id);
    } finally { await request(`/${first}`, 'DELETE'); await request(`/${second}`, 'DELETE'); }
});

test.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await db.closeDatabase(); await rm(directory, { recursive: true, force: true });
});
