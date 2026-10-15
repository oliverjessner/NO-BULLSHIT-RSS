import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-statistics-'));
process.env.DB_PATH = path.join(directory, 'statistics.db');
const database = await import('../database/datenbank.js');
const { getStatistics } = await import('./statistics.js');
const { default: articlesRouter } = await import('../routes/articles.js');
await database.initSchema();

test('returns real zero counts and empty rankings for an empty library', async () => {
    assert.deepEqual(await getStatistics(), { totalArticles: 0, bullshitArticles: 0, topFeeds: [], topTopics: [] });
});

test('counts all stored articles, limits rankings and counts each bullshit article once', async () => {
    await database.run(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES (1, 'Source fallback', 'https://example.test', 'https://example.test/', datetime('now'), datetime('now'))`);
    const counts = [13, 11, 11, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    for (let index = 0; index < counts.length; index += 1) {
        const id = index + 1;
        const name = ['', 'Zeta', 'Alpha'][index] ?? `Feed ${id}`;
        const label = ['AI', 'Zebra', 'Apple'][index] ?? `Topic ${id}`;
        await database.run(`INSERT INTO feeds (id, sourceId, name, feedUrl, createdAt, updatedAt)
            VALUES (?, 1, ?, ?, datetime('now'), datetime('now'))`, [id, name, `https://example.test/${id}.rss`]);
        await database.run(`INSERT INTO topics (id, slug, label, configJson, ruleVersion, ruleHash, createdAt, updatedAt)
            VALUES (?, ?, ?, '{}', 1, 'test', datetime('now'), datetime('now'))`, [id, `topic-${id}`, label]);
        for (let article = 0; article < counts[index]; article += 1) {
            const row = await database.run(`INSERT INTO articles
                (feedId, externalId, title, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
                VALUES (?, ?, 'Article', 'hash', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`, [id, `${id}-${article}`]);
            await database.run(`INSERT INTO article_topics (articleId, topicId, score, matchedTermsJson, classificationVersion, createdAt)
                VALUES (?, ?, 10, '{}', 'test', datetime('now'))`, [row.lastID, id]);
        }
    }
    await database.exec(`INSERT INTO bullshit_rules (id, name, enabled, field, operator, value, createdAt, updatedAt) VALUES
        (100, 'One', 1, 'title', 'contains', 'one', datetime('now'), datetime('now')),
        (101, 'Two', 1, 'title', 'contains', 'two', datetime('now'), datetime('now'));
        INSERT INTO article_bullshit_matches VALUES (1, 100, datetime('now')), (2, 100, datetime('now')),
            (2, 101, datetime('now')), (3, 101, datetime('now'));
        INSERT INTO article_state (articleId, dismissedAt, createdAt, updatedAt)
            VALUES (1, datetime('now'), datetime('now'), datetime('now'));`);

    const result = await getStatistics();
    assert.equal(result.totalArticles, 80);
    assert.equal(result.bullshitArticles, 3);
    assert.equal(result.topFeeds.length, 10);
    assert.equal(result.topTopics.length, 10);
    assert.deepEqual(result.topFeeds.slice(0, 3), [
        { id: 1, name: 'Source fallback', count: 13 }, { id: 3, name: 'Alpha', count: 11 }, { id: 2, name: 'Zeta', count: 11 },
    ]);
    assert.deepEqual(result.topTopics.slice(0, 3), [
        { id: 1, name: 'AI', count: 13 }, { id: 3, name: 'Apple', count: 11 }, { id: 2, name: 'Zebra', count: 11 },
    ]);
    assert.equal(result.topFeeds.at(-1).count, 3);
    assert.equal(result.topTopics.at(-1).count, 3);
});

test('serves fresh statistics without caching and leaves the basic stats endpoint compatible', async t => {
    const app = express();
    app.use('/api/articles', articlesRouter);
    const server = createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/articles`;
    const first = await fetch(`${base}/statistics`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await first.json(), await getStatistics());
    assert.deepEqual(await (await fetch(`${base}/stats`)).json(), { total: 80, unread: 79, dismissed: 1 });
    await database.run('DELETE FROM articles WHERE id = 1');
    const refreshed = await (await fetch(`${base}/statistics`)).json();
    assert.equal(refreshed.totalArticles, 79);
    assert.equal(refreshed.bullshitArticles, 2);
    assert.equal(refreshed.topFeeds[0].count, 12);
});

test.after(async () => {
    await database.closeDatabase();
    await rm(directory, { recursive: true, force: true });
});
