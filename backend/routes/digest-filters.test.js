import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-digest-filters-'));
process.env.DB_PATH = path.join(directory, 'filters.db');
const database = await import('../database/datenbank.js');
const { ingestArticle } = await import('../services/article-ingest.js');
const { generateDirtyDigestPeriods, getStoredDigestPayload } = await import('../services/digest-store.js');
const { readStoredDigestPayload } = await import('../services/digest-reader.js');
const { createBullshitRule, reevaluateAllArticles } = await import('../services/bullshit-rules.js');
const { default: articlesRouter } = await import('./articles.js');
const { default: rulesRouter } = await import('./bullshit-rules.js');
const { default: settingsRouter } = await import('./digest-settings.js');
await database.initSchema();

const app = express();
app.use(express.json());
app.use('/api/articles', articlesRouter);
app.use('/api/bullshit-rules', rulesRouter);
app.use('/api/digest-settings', settingsRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const base = `http://127.0.0.1:${server.address().port}/api`;
const request = (url, method, body) => fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ids = payload => payload.clusters.flatMap(cluster => cluster.items.map(item => item.id)).sort((a, b) => a - b);
let clean;
let other;
let noisy;

test.beforeEach(async () => {
    await database.exec('DELETE FROM digest_periods; DELETE FROM sources; DELETE FROM bullshit_rules;');
    await reevaluateAllArticles();
    for (let id = 1; id <= 3; id += 1) {
        await database.run(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`, [id, `Source ${id}`, `https://source${id}.test`, `https://source${id}.test/`]);
        await database.run(`INSERT INTO feeds (id, sourceId, feedUrl, createdAt, updatedAt)
            VALUES (?, ?, ?, datetime('now'), datetime('now'))`, [id, id, `https://source${id}.test/rss`]);
    }
    const article = { title: 'Rocket mission launches a weather satellite', teaser: 'New satellite reaches orbit', url: 'https://example.test/story' };
    clean = await ingestArticle({ ...article, feedId: 1, externalId: 'clean', publishedAt: new Date(Date.now() - 2000).toISOString() });
    other = await ingestArticle({ ...article, feedId: 2, externalId: 'other', publishedAt: new Date(Date.now() - 1000).toISOString() });
    noisy = await ingestArticle({ ...article, title: `Sponsored: ${article.title}`, feedId: 3, externalId: 'noisy' });
    await generateDirtyDigestPeriods();
});

test('rule creation, disabling and deletion rebuild every digest while Feed keeps its Clean filter', async () => {
    const created = await request('/bullshit-rules', 'POST', { name: 'Sponsored', field: 'title', operator: 'contains', value: 'Sponsored', enabled: true });
    assert.equal(created.status, 201);
    const { rule } = await created.json();
    for (const variant of ['day', 'week', 'month']) {
        const payload = await (await fetch(`${base}/articles/digest?variant=${variant}`)).json();
        assert.deepEqual(ids(payload), [clean.id, other.id]);
        assert.deepEqual(ids(await readStoredDigestPayload(variant, database)), [clean.id, other.id]);
        assert.equal(payload.stale, false);
    }
    const all = await (await fetch(`${base}/articles`)).json();
    const filtered = await (await fetch(`${base}/articles?bullshit=clean`)).json();
    assert.equal(all.length, 3);
    assert.deepEqual(filtered.map(item => item.id).sort((a, b) => a - b), [clean.id, other.id]);

    assert.equal((await request(`/bullshit-rules/${rule.id}`, 'PATCH', { enabled: false })).status, 200);
    assert.equal((await getStoredDigestPayload('day')).totalArticles, 3);
    assert.equal((await request(`/bullshit-rules/${rule.id}`, 'PATCH', { enabled: true })).status, 200);
    assert.equal((await getStoredDigestPayload('day')).totalArticles, 2);
    assert.equal((await request(`/bullshit-rules/${rule.id}`, 'DELETE')).status, 200);
    assert.equal((await getStoredDigestPayload('day')).totalArticles, 3);
});

test('saved generations hide new rule matches immediately and repair titles and counts, including closed periods', async () => {
    const initial = await getStoredDigestPayload('day');
    assert.equal(initial.clusters.length, 1);
    assert.equal(initial.clusters[0].representative.id, noisy.id);
    await createBullshitRule({ name: 'Sponsored', field: 'title', operator: 'contains', value: 'Sponsored' });
    await reevaluateAllArticles();
    await database.run("UPDATE digest_periods SET status = 'closed' WHERE type = 'day'");
    for (const read of [getStoredDigestPayload, variant => readStoredDigestPayload(variant, database)]) {
        const payload = await read('day');
        assert.deepEqual(ids(payload), [clean.id, other.id]);
        assert.equal(payload.clusters[0].clusterCount, 2);
        assert.doesNotMatch(payload.clusters[0].clusterTitle, /Sponsored/u);
        assert.notEqual(payload.clusters[0].representative.id, noisy.id);
    }
});

test('individual feed switches persist independently, are reversible and only exclude Digest articles', async () => {
    const toggle = async (id, excluded) => {
        const response = await request(`/digest-settings/excluded-feeds/${id}`, 'PATCH', { excluded });
        assert.equal(response.status, 200);
        return response.json();
    };
    assert.deepEqual(await toggle(2, true), { excludedFeedIds: [2] });
    assert.deepEqual(ids(await getStoredDigestPayload('day')), [clean.id, noisy.id]);
    assert.deepEqual(await toggle(3, true), { excludedFeedIds: [2, 3] });
    assert.deepEqual(await toggle(3, true), { excludedFeedIds: [2, 3] });
    assert.deepEqual(ids(await getStoredDigestPayload('day')), [clean.id]);
    assert.equal((await getStoredDigestPayload('month')).totalClusters, 0);
    assert.equal((await (await fetch(`${base}/articles`)).json()).length, 3);
    assert.deepEqual(await toggle(2, false), { excludedFeedIds: [3] });
    assert.deepEqual(ids(await getStoredDigestPayload('day')), [clean.id, other.id]);
    assert.deepEqual(await toggle(3, false), { excludedFeedIds: [] });
    assert.equal((await getStoredDigestPayload('month')).totalArticles, 3);
});

test('rejects invalid switches without changing exclusions and removes blocked-word endpoints', async () => {
    assert.equal((await request('/digest-settings/excluded-feeds/1', 'PATCH', { excluded: 'true' })).status, 400);
    assert.equal((await request('/digest-settings/excluded-feeds/999', 'PATCH', { excluded: true })).status, 404);
    assert.equal((await request('/digest-settings/blocked-words', 'POST', { word: 'noise' })).status, 404);
    assert.deepEqual(await (await fetch(`${base}/digest-settings`)).json(), { excludedFeedIds: [] });
});

test.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await database.closeDatabase();
    await rm(directory, { recursive: true, force: true });
});
