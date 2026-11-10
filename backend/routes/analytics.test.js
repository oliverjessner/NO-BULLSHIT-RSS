import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-analytics-api-'));
process.env.DB_PATH = path.join(directory, 'analytics.db');
const database = await import('../database/datenbank.js');
await database.initSchema();
const { createAnalyticsRouter } = await import('./analytics.js');
const app = express();
app.use('/api/analytics', createAnalyticsRouter({ now: () => new Date('2026-11-10T12:00:00.000Z') }));
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/analytics`;

test('all Analytics endpoints return genuine empty-library data without changing stored state', async () => {
    const before = await database.get('SELECT COUNT(*) AS count FROM articles');
    for (const section of ['overview', 'trends', 'publishers', 'most-read', 'topics', 'library', 'filters']) {
        const response = await fetch(`${base}/${section}`);
        assert.equal(response.status, 200, `${section}: ${await response.clone().text()}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        if (section === 'overview') assert.equal(result.kpis.totalArticles, 0);
        if (section === 'most-read') assert.equal(result.metrics.uniqueRankedArticles, 0);
        if (section === 'filters') assert.deepEqual(result.publishers, []);
    }
    assert.deepEqual(await database.get('SELECT COUNT(*) AS count FROM articles'), before);
    const legacy = await import('../services/statistics.js');
    assert.deepEqual(await legacy.getStatistics(), { totalArticles: 0, bullshitArticles: 0, topFeeds: [], topTopics: [] });
});

test('API rejects unsupported filters, SQL fragments and malformed history targets', async () => {
    for (const query of ['period=365d', 'publisher=1%20OR%201%3D1', 'topic=x%27', 'rankingKey=visits', 'limit=201', 'offset=-1',
        'group=hour', 'basis=content', 'sort=content', 'extra=1', 'compare=1,2,3', 'topics=a,b,c,d,e,f,g,h,i']) {
        const response = await fetch(`${base}/overview?${query}`);
        assert.equal(response.status, 400, query);
    }
    for (const query of ['', 'sourceId=1', 'sourceId=1&url=javascript:alert(1)', 'sourceId=1&url=https://example.com/&historyLimit=1001']) {
        assert.equal((await fetch(`${base}/most-read/history?${query}`)).status, 400, query);
    }
});

test('only read endpoints exist', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await fetch(`${base}/overview`, { method })).status, 404);
});

test.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await database.closeDatabase();
    await rm(directory, { recursive: true, force: true });
});
