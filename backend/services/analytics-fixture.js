import sqlite3 from '@vscode/sqlite3';
import { readFile, readdir } from 'node:fs/promises';

/** Dedicated in-memory database: analytics tests never open the user's library. */
export async function analyticsFixture({ seed = true } = {}) {
    const connection = new sqlite3.Database(':memory:');
    const database = {
        get: (sql, params = []) => new Promise((resolve, reject) => connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row))),
        all: (sql, params = []) => new Promise((resolve, reject) => connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows))),
        run: (sql, params = []) => new Promise((resolve, reject) => connection.run(sql, params, function (error) { error ? reject(error) : resolve({ lastID: this.lastID, changes: this.changes }); })),
        exec: sql => new Promise((resolve, reject) => connection.exec(sql, error => error ? reject(error) : resolve())),
        close: () => new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve())),
    };
    const migrations = new URL('../../migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => /^\d+_.+\.sql$/.test(name)).sort()) await database.exec(await readFile(new URL(name, migrations), 'utf8'));
    if (seed) await seedAnalyticsFixture(database);
    return database;
}

export async function addAnalyticsArticle(database, { id, feedId = 1, publishedAt = '2026-11-09T12:00:00.000Z', fetchedAt = publishedAt, topics = [], status = 'ready', url = `https://golem.de/news/${id}` }) {
    await database.run(`INSERT INTO articles (id, feedId, externalId, title, url, canonicalUrl, contentHash, publishedAt, fetchedAt, createdAt, updatedAt, classificationStatus)
        VALUES (?, ?, ?, ?, ?, ?, 'fixture', ?, ?, ?, ?, ?)`, [id, feedId, `article-${id}`, `Article ${id}`, url, url, publishedAt, fetchedAt, publishedAt, fetchedAt, status]);
    for (const topicId of topics) await database.run(`INSERT INTO article_topics (articleId, topicId, score, classificationVersion, createdAt)
        VALUES (?, ?, 1, 'fixture', ?)`, [id, topicId, fetchedAt]);
}

export async function seedAnalyticsFixture(database) {
    await database.exec(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt) VALUES
        (1, 'Golem', 'https://golem.de', 'https://golem.de/', '2026-01-01', '2026-01-01'),
        (2, 'Example', 'https://example.test', 'https://example.test/', '2026-01-01', '2026-01-01'),
        (3, 'TechCrunch', 'https://techcrunch.com', 'https://techcrunch.com/', '2026-01-01', '2026-01-01');
        INSERT INTO feeds (id, sourceId, name, feedUrl, createdAt, updatedAt) VALUES
        (1, 1, 'Golem news', 'https://golem.de/rss.xml', '2026-01-01', '2026-01-01'),
        (2, 1, 'Golem tech', 'https://golem.de/tech/rss.xml', '2026-01-01', '2026-01-01'),
        (3, 2, '', 'https://example.test/rss', '2026-01-01', '2026-01-01'),
        (4, 3, 'TechCrunch', 'https://techcrunch.com/feed', '2026-01-01', '2026-01-01'),
        (5, 2, 'Manual imports', 'manual:imports', '2026-01-01', '2026-01-01');
        INSERT INTO topics (id, slug, label, configJson, ruleHash, ruleVersion, createdAt, updatedAt) VALUES
        (1, 'ai', 'AI', '{}', 'fixture', 1, '2026-01-01', '2026-01-01'),
        (2, 'climate', 'Climate', '{}', 'fixture', 1, '2026-01-01', '2026-01-01'),
        (3, 'tech', 'Technology', '{}', 'fixture', 1, '2026-01-01', '2026-01-01'),
        (4, 'emerging', 'Emerging', '{}', 'fixture', 1, '2026-01-01', '2026-01-01');`);
    await addAnalyticsArticle(database, { id: 1, topics: [1, 3], url: 'https://golem.de/shared' });
    await addAnalyticsArticle(database, { id: 2, feedId: 2, publishedAt: '2026-11-08 08:00:00', topics: [1], url: 'https://golem.de/shared' });
    await addAnalyticsArticle(database, { id: 3, feedId: 3, publishedAt: '2026-11-08T10:00:00Z', topics: [1, 2] });
    await addAnalyticsArticle(database, { id: 4, feedId: 3, publishedAt: '2026-10-20T10:00:00Z', topics: [2], status: 'pending' });
    await addAnalyticsArticle(database, { id: 5, publishedAt: '2026-10-30T10:00:00Z', topics: [3], status: 'failed' });
    await addAnalyticsArticle(database, { id: 6, feedId: 4, publishedAt: '2026-11-06T10:00:00Z', topics: [1] });
    await addAnalyticsArticle(database, { id: 7, publishedAt: '2026-10-10T10:00:00Z', topics: [1] });
    await addAnalyticsArticle(database, { id: 8, feedId: 3, publishedAt: '2026-11-11T10:00:00Z', topics: [], status: 'pending' });
    await database.exec(`INSERT INTO lists (id, name, createdAt, updatedAt) VALUES (1, 'One', '2026-01-01', '2026-01-01'), (2, 'Two', '2026-01-01', '2026-01-01');
        INSERT INTO list_items (listId, articleId, createdAt) VALUES (1, 1, '2026-11-09'), (2, 1, '2026-11-09');
        INSERT INTO article_state (articleId, readAt, dismissedAt, createdAt, updatedAt) VALUES
        (1, '2026-11-09', NULL, '2026-11-09', '2026-11-09'), (2, NULL, '2026-11-09', '2026-11-09', '2026-11-09');
        INSERT INTO article_bullshit_matches (articleId, ruleId, matchedAt) SELECT 1, id, '2026-11-09' FROM bullshit_rules LIMIT 2;
        INSERT INTO most_read (sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt) VALUES
        (1, 1, 'https://golem.de/shared', 'Article one', 3, 'most_read', '2026-11-07T08:00:00Z'),
        (1, 1, 'https://golem.de/shared', 'Article one', 1, 'most_read', '2026-11-09T12:00:00Z'),
        (1, 1, 'https://golem.de/shared', 'Article one', 2, 'most_commented', '2026-11-09T12:00:00Z'),
        (1, 2, 'https://golem.de/two', 'Article two', 2, 'most_read', '2026-11-09T12:00:00Z'),
        (1, NULL, 'https://golem.de/external', 'External article', 3, 'most_read', '2026-11-09T12:00:00Z'),
        (3, 6, 'https://techcrunch.com/six', 'Article six', 1, 'top_news', '2026-11-09T12:00:00Z');`);
}

/** Reproducible scale fixture. Includes URL copies across feeds and unlinked rank URLs. */
export async function seedAnalyticsBenchmark(database, { articles = 100_000, rankings = 100_000 } = {}) {
    if (![articles, rankings].every(value => Number.isSafeInteger(value) && value >= 4 && value <= 1_000_000)) throw new TypeError('Invalid benchmark size');
    await database.exec('DELETE FROM articles; DELETE FROM most_read;');
    await database.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?)
        INSERT INTO articles (id, feedId, externalId, title, url, canonicalUrl, contentHash, publishedAt, fetchedAt, createdAt, updatedAt, classificationStatus)
        SELECT x, 1 + (x % 4), 'benchmark-' || x, 'Synthetic ' || x,
            'https://benchmark.test/article/' || CAST(x / 2 AS INTEGER), 'https://benchmark.test/article/' || CAST(x / 2 AS INTEGER), 'hash',
            strftime('%Y-%m-%dT%H:%M:%SZ', '2026-11-10T00:00:00Z', '-' || (x % 120) || ' days'),
            strftime('%Y-%m-%dT%H:%M:%SZ', '2026-11-10T00:00:00Z', '-' || (x % 120) || ' days'),
            '2026-01-01', '2026-01-01', 'ready' FROM n`, [articles]);
    await database.exec(`INSERT INTO article_topics (articleId, topicId, score, classificationVersion, createdAt)
        SELECT id, 1, 1, 'benchmark', '2026-01-01' FROM articles;
        INSERT INTO article_topics (articleId, topicId, score, classificationVersion, createdAt)
        SELECT id, 2, 1, 'benchmark', '2026-01-01' FROM articles WHERE id % 3 = 0;`);
    await database.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?),
        ranked AS (SELECT x, 1 + 4 * ((x - 1) % CAST(? / 4 AS INTEGER)) AS localId FROM n)
        INSERT INTO most_read (sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt)
        SELECT 1, CASE WHEN x % 3 = 0 THEN NULL ELSE localId END,
            'https://benchmark.test/article/' || CAST(localId / 2 AS INTEGER), 'Synthetic rank ' || x,
            1 + (x % 100), 'most_read',
            strftime('%Y-%m-%dT%H:%M:%SZ', '2026-11-10T00:00:00Z', '-' || CAST(x / 100 AS INTEGER) || ' hours')
        FROM ranked`, [rankings, articles]);
}
