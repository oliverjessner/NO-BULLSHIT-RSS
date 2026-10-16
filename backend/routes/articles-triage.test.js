import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-triage-'));
process.env.DB_PATH = path.join(testDirectory, 'triage.db');

const database = await import('../database/datenbank.js');
const { default: articlesRouter, setArticleDismissedState, setArticlesDigestedStateInTransaction } = await import('./articles.js');
const { ingestArticle } = await import('../services/article-ingest.js');
const { generateDirtyDigestPeriods } = await import('../services/digest-store.js');

await database.initSchema();
await database.run(
    `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
     VALUES ('Test source', 'https://example.com', 'https://example.com/', datetime('now'), datetime('now'))`,
);
await database.run(
    "INSERT INTO feeds (sourceId, feedUrl, createdAt, updatedAt) VALUES (1, 'https://example.com/rss', datetime('now'), datetime('now'))",
);
await ingestArticle({ feedId: 1, externalId: 'test-guid', title: 'Test article', teaser: 'A useful summary', url: 'https://example.com/article' });
await generateDirtyDigestPeriods();
await database.run("INSERT INTO lists (name, description, color, createdAt, updatedAt) VALUES ('Saved', '', '#111111', datetime('now'), datetime('now'))");
await database.run("INSERT INTO list_items (listId, articleId, createdAt) VALUES (1, 1, datetime('now'))");

test('persists saved, dismissed and digested triage states with undo', async () => {
    const initial = await database.get(
        `SELECT article_state.dismissedAt,
         EXISTS (SELECT 1 FROM list_items WHERE list_items.articleId = articles.id) AS saved
         FROM articles JOIN article_state ON article_state.articleId = articles.id WHERE articles.id = 1`,
    );
    assert.equal(initial.saved, 1);
    assert.equal(initial.dismissedAt, null);

    assert.equal(await setArticleDismissedState(1, true), true);
    assert.equal(Number((await database.get('SELECT COUNT(*) AS total FROM article_state WHERE dismissedAt IS NULL')).total), 0);

    assert.equal(await setArticleDismissedState(1, false), true);
    assert.equal(Number((await database.get('SELECT COUNT(*) AS total FROM article_state WHERE dismissedAt IS NULL')).total), 1);

    await setArticlesDigestedStateInTransaction([1], true);
    assert.equal(Number((await database.get('SELECT COUNT(*) AS total FROM digest_cluster_state WHERE completedAt IS NOT NULL')).total), 1);

    await setArticlesDigestedStateInTransaction([1], false);
    assert.equal(Number((await database.get('SELECT COUNT(*) AS total FROM digest_cluster_state WHERE completedAt IS NOT NULL')).total), 0);
});

test('API filters articles without topics before pagination and combines other filters', async t => {
    await database.run("UPDATE articles SET publishedAt = '2026-01-01T12:00:00.000Z' WHERE id = 1");
    const unassigned = await ingestArticle({ feedId: 1, externalId: 'unassigned', title: 'Unassigned report', url: 'https://example.com/unassigned', publishedAt: '2026-01-02T12:00:00.000Z' });
    const tagged = await ingestArticle({ feedId: 1, externalId: 'tagged', title: 'Tagged report', url: 'https://example.com/tagged', publishedAt: '2026-01-03T12:00:00.000Z' });
    const dismissed = await ingestArticle({ feedId: 1, externalId: 'dismissed', title: 'Dismissed report', url: 'https://example.com/dismissed', publishedAt: '2026-01-04T12:00:00.000Z' });
    await setArticleDismissedState(dismissed.id, true);
    const topic = await database.run(
        `INSERT INTO topics (slug, label, configJson, ruleHash, ruleVersion, createdAt, updatedAt)
         VALUES ('test-topic', 'Test', '{}', 'test', 1, datetime('now'), datetime('now'))`,
    );
    const assignTopic = articleId => database.run(
        `INSERT INTO article_topics (articleId, topicId, score, matchedTermsJson, classificationVersion, createdAt)
         VALUES (?, ?, 10, '{}', 'test', datetime('now'))`,
        [articleId, topic.lastID],
    );
    await assignTopic(tagged.id);

    const app = express();
    app.use('/api/articles', articlesRouter);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}/api/articles`;
    const read = async query => {
        const response = await fetch(`${base}?${query}`);
        assert.equal(response.status, 200);
        return response.json();
    };

    const page = await read('noTopic=true&limit=1');
    assert.deepEqual(page.map(article => article.id), [unassigned.id]);
    assert.deepEqual(page[0].topics, []);
    const cursor = new URLSearchParams({ noTopic: 'true', limit: '1', cursorPublishedAt: page[0].publishedAt, cursorId: String(page[0].id) });
    assert.deepEqual((await read(cursor)).map(article => article.id), [1]);
    assert.deepEqual((await read('noTopic=true&query=Unassigned')).map(article => article.id), [unassigned.id]);
    assert.deepEqual((await read('noTopic=1&feedId=1&listId=1&bullshit=clean')).map(article => article.id), [1]);
    assert.deepEqual((await read('topic=test-topic')).map(article => article.id), [tagged.id]);
    for (const query of ['', 'noTopic=false', 'noTopic=0']) {
        assert.deepEqual((await read(query)).map(article => article.id), [tagged.id, unassigned.id, 1]);
    }
    const conflict = await fetch(`${base}?noTopic=true&topic=test-topic`);
    assert.equal(conflict.status, 400);
    assert.match((await conflict.json()).error, /Only one of topic or noTopic/u);

    await assignTopic(1);
    await assignTopic(unassigned.id);
    assert.deepEqual(await read('noTopic=true'), []);
});

test.after(async () => {
    await new Promise(resolve => database.default.close(resolve));
    await rm(testDirectory, { recursive: true, force: true });
});
