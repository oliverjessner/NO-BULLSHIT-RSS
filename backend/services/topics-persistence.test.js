import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'nbs-topics-'));
process.env.DB_PATH = path.join(testDirectory, 'topics.sqlite');
process.env.TOPIC_RULES_FILE_PATH = path.join(testDirectory, 'topics.rules.json');

const database = await import('../database/datenbank.js');
const topics = await import('./topics.js');
const { ingestArticle } = await import('./article-ingest.js');

after(async () => {
    await new Promise(resolve => database.default.close(resolve));
    await rm(testDirectory, { recursive: true, force: true });
});

test('topic config persists and reprocessing assigns only eligible topics', async () => {
    await database.initSchema();
    await topics.saveTopicsFromDefinitions([
        {
            slug: 'ai',
            label: 'AI',
            type: 'technology',
            minMatches: 2,
            exclude: ['stock market'],
            strong: ['openai', 'chatgpt'],
            medium: [],
            weak: [],
        },
    ]);

    const [loaded] = await topics.getTopicDefinitions({ force: true });
    assert.equal(loaded.type, 'technology');
    assert.equal(loaded.minMatches, 2);
    assert.deepEqual(loaded.exclude, ['stock market']);

    const source = await database.run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ['Test feed', 'https://example.test', 'https://example.test/'],
    );
    const feed = await database.run(
        "INSERT INTO feeds (sourceId, feedUrl, createdAt, updatedAt) VALUES (?, ?, datetime('now'), datetime('now'))",
        [source.lastID, 'https://example.test/feed'],
    );
    await ingestArticle({ feedId: feed.lastID, externalId: 'topic-test-article', title: 'OpenAI updates ChatGPT', teaser: 'Both products improve', url: 'https://example.test/article' });
    await database.run("UPDATE articles SET classificationStatus = 'pending'");

    const result = await topics.reprocessTopicClassificationForAllArticles();
    const assignments = await database.all('SELECT topics.slug AS topicSlug FROM article_topics JOIN topics ON topics.id = article_topics.topicId ORDER BY topics.slug');

    assert.equal(result.processed, 1);
    assert.equal(result.topicAssignments, 1);
    assert.deepEqual(assignments.map(row => row.topicSlug), ['ai']);
});

test('reprocessing completes across multiple batches and skips current classifications', async t => {
    await database.initSchema();
    await database.run('DELETE FROM articles');
    await topics.saveTopicsFromDefinitions([
        { slug: 'ai', label: 'AI', strong: ['openai', 'chatgpt'], minMatches: 2 },
    ]);
    const classificationVersion = await topics.getActiveTopicRulesVersion();
    const source = await database.run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ['Batch test feed', 'https://batch.example.test', 'https://batch.example.test/'],
    );
    const feed = await database.run(
        "INSERT INTO feeds (sourceId, feedUrl, createdAt, updatedAt) VALUES (?, ?, datetime('now'), datetime('now'))",
        [source.lastID, 'https://batch.example.test/feed'],
    );
    let currentArticleId;
    await database.transaction(async () => {
        for (let index = 0; index < 502; index += 1) {
            const current = index === 501;
            const status = current || index === 1 || index === 2 ? 'ready' : index === 0 ? 'failed' : 'pending';
            const version = current ? classificationVersion : index === 1 ? 'outdated-version' : null;
            const article = await database.run(
                `INSERT INTO articles (feedId, externalId, title, contentHash, classificationStatus, classificationVersion,
                                       publishedAt, fetchedAt, createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))`,
                [feed.lastID, `batch-${index}`, 'OpenAI updates ChatGPT', `batch-hash-${index}`, status, version],
            );
            if (current) currentArticleId = article.lastID;
        }
    });
    const log = t.mock.method(console, 'log', () => {});

    const result = await topics.reprocessTopicClassificationForAllArticles();

    assert.deepEqual(result, {
        processed: 501,
        assignedArticles: 501,
        topicAssignments: 501,
        failed: 0,
        totalArticles: 502,
        topicCount: 1,
    });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM article_topics')).count, 501);
    assert.equal((await database.get(
        "SELECT COUNT(*) AS count FROM articles WHERE classificationStatus = 'ready' AND classificationVersion = ?",
        [classificationVersion],
    )).count, 502);
    assert.deepEqual(await topics.getArticleTopics(currentArticleId), []);
    assert.deepEqual(
        log.mock.calls
            .map(call => call.arguments[0])
            .filter(message => message.startsWith('[INFO] Topic reprocess progress '))
            .map(message => JSON.parse(message.slice('[INFO] Topic reprocess progress '.length))),
        [{ processed: 250, total: 501 }, { processed: 500, total: 501 }],
    );

    const repeated = await topics.reprocessTopicClassificationForAllArticles();
    assert.equal(repeated.processed, 0);
    assert.equal(repeated.failed, 0);
});
