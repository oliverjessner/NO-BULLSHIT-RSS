import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'nbs-article-import-'));
process.env.DB_PATH = path.join(testDirectory, 'article-import.db');
process.env.TOPIC_RULES_FILE_PATH = path.resolve('topics.rules.json');

const database = await import('../database/datenbank.js');
const {
    deriveImportedArticleTitle,
    importArticlesFromUrls,
    isManualImportFeedUrl,
    normalizeImportDomain,
    normalizeImportUrl,
} = await import('./article-import.js');
const { queryArticles } = await import('./article-queries.js');
const { ensureTopicDefinitionsInitialized } = await import('./topics.js');

test.before(async () => {
    await database.initSchema();
    await ensureTopicDefinitionsInitialized();
});

test.after(async () => {
    await database.closeDatabase();
    await rm(testDirectory, { recursive: true, force: true });
});

test('normalizes only public-style HTTP(S) article URLs', () => {
    assert.equal(normalizeImportUrl(' https://example.com/story#comments '), 'https://example.com/story');
    assert.equal(normalizeImportUrl('https://example.com/story?id=42&UTM_Source=rss#comments'), 'https://example.com/story?id=42');
    assert.equal(normalizeImportUrl('ftp://example.com/story'), null);
    assert.equal(normalizeImportUrl('not a url'), null);
    assert.equal(normalizeImportUrl('https://user:secret@example.com/story'), null);
});

test('normalizes domains for matching existing feeds', () => {
    assert.equal(normalizeImportDomain('https://WWW.Example.com./story'), 'example.com');
    assert.equal(normalizeImportDomain('not a url'), null);
});

test('derives a readable local title from the final URL segment', () => {
    assert.equal(deriveImportedArticleTitle('https://example.com/news/hello-world.html'), 'hello world');
    assert.equal(deriveImportedArticleTitle('https://example.com/'), 'example.com');
});

test('imports links through the normal ingest pipeline and creates hidden manual feeds', async () => {
    const result = await importArticlesFromUrls([
        'https://example.com/news/hello-world?utm_source=test',
        'https://example.com/news/hello-world',
        'invalid',
    ]);

    assert.deepEqual(
        { received: result.received, imported: result.imported, duplicates: result.duplicates, invalid: result.invalid, failed: result.failed },
        { received: 3, imported: 1, duplicates: 1, invalid: 1, failed: 0 },
    );
    const feed = await database.get('SELECT name, feedUrl FROM feeds');
    assert.equal(feed.name, 'example.com (Imported)');
    assert.equal(isManualImportFeedUrl(feed.feedUrl), true);

    const rows = await queryArticles({}, { all: database.all });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'hello world');
    assert.equal(rows[0].sourceName, 'example.com (Imported)');
});

test('re-importing an existing canonical URL does not create another article', async () => {
    const result = await importArticlesFromUrls(['https://example.com/news/hello-world#again']);
    assert.equal(result.imported, 0);
    assert.equal(result.duplicates, 1);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM articles')).count, 1);
});

test('assigns imports to an existing feed when the website domain matches', async () => {
    await database.run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ['Publisher', 'https://publisher.test/', 'https://publisher.test/'],
    );
    const source = await database.get('SELECT id FROM sources WHERE canonicalWebsiteUrl = ?', ['https://publisher.test/']);
    const created = await database.run(
        `INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        [source.id, 'Publisher News', 'https://feeds.publisher.test/rss.xml'],
    );

    const result = await importArticlesFromUrls(['https://www.publisher.test/news/domain-match']);
    assert.equal(result.imported, 1);
    const article = await database.get('SELECT feedId FROM articles WHERE id = ?', [result.articleIds[0]]);
    assert.equal(Number(article.feedId), Number(created.lastID));
    assert.equal(
        (await database.get('SELECT COUNT(*) AS count FROM feeds WHERE feedUrl = ?', ['nbs-import:https://www.publisher.test'])).count,
        0,
    );
});

test('also matches the configured RSS feed domain', async () => {
    await database.run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ['Syndicated', 'https://syndicated-home.test/', 'https://syndicated-home.test/'],
    );
    const source = await database.get('SELECT id FROM sources WHERE canonicalWebsiteUrl = ?', ['https://syndicated-home.test/']);
    const created = await database.run(
        `INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        [source.id, 'Syndicated Feed', 'https://news.syndicated.test/rss'],
    );

    const result = await importArticlesFromUrls(['https://news.syndicated.test/article/feed-domain-match']);
    assert.equal(result.imported, 1);
    const article = await database.get('SELECT feedId FROM articles WHERE id = ?', [result.articleIds[0]]);
    assert.equal(Number(article.feedId), Number(created.lastID));
});

test('prefers a website-domain match over another feeds shared RSS host', async () => {
    await database.run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ['Shared host user', 'https://shared-host-user.test/', 'https://shared-host-user.test/'],
    );
    const firstSource = await database.get('SELECT id FROM sources WHERE canonicalWebsiteUrl = ?', ['https://shared-host-user.test/']);
    await database.run(
        `INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        [firstSource.id, 'Shared RSS host user', 'https://publisher-priority.test/rss/other'],
    );
    await database.run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ['Priority Publisher', 'https://publisher-priority.test/', 'https://publisher-priority.test/'],
    );
    const prioritySource = await database.get('SELECT id FROM sources WHERE canonicalWebsiteUrl = ?', ['https://publisher-priority.test/']);
    const priorityFeed = await database.run(
        `INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        [prioritySource.id, 'Priority Publisher', 'https://rss-host.test/priority'],
    );

    const result = await importArticlesFromUrls(['https://publisher-priority.test/article/website-wins']);
    const article = await database.get('SELECT feedId FROM articles WHERE id = ?', [result.articleIds[0]]);
    assert.equal(Number(article.feedId), Number(priorityFeed.lastID));
});

test('Linkary upgrades recognize legacy tracking and query encoding without duplicating imported articles', async () => {
    for (const [cleanUrl, oldCanonical, oldUrl] of [
        ['https://legacy-linkary.test/story?id=42', 'https://legacy-linkary.test/story?id=42&msclkid=old', 'https://legacy-linkary.test/story?id=42&msclkid=old#top'],
        ['https://legacy-linkary.test/search?q=a%20b', 'https://legacy-linkary.test/search?q=a+b', 'https://legacy-linkary.test/search?q=a%20b&UTM_Source=old'],
    ]) {
        const original = await importArticlesFromUrls([cleanUrl]);
        const id = original.articleIds[0];
        await database.run('UPDATE articles SET canonicalUrl = ?, url = ?, externalId = ? WHERE id = ?', [oldCanonical, oldUrl, oldCanonical, id]);
        const before = (await database.get('SELECT COUNT(*) AS count FROM articles')).count;
        const duplicate = await importArticlesFromUrls([cleanUrl]);
        assert.equal(duplicate.imported, 0);
        assert.equal(duplicate.duplicates, 1);
        assert.deepEqual(duplicate.articleIds, [id]);
        assert.equal((await database.get('SELECT COUNT(*) AS count FROM articles')).count, before);
    }
});
