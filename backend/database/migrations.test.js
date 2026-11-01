import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-migrations-'));
process.env.DB_PATH = path.join(testDirectory, 'migrations.sqlite');

const database = await import('./datenbank.js');
const migrationVersions = [
    '0001_schema.sql',
    '0002_feed_names.sql',
    '0003_bullshit_rules.sql',
    '0004_default_bullshit_rules.sql',
    '0005_unified_digest_filters.sql',
    '0006_watchdogs.sql',
    '0007_watchdog_export_index.sql',
    '0008_most_read.sql',
    '0009_top_news.sql',
];
const migrationSql = version => readFile(new URL(`../../migrations/${version}`, import.meta.url), 'utf8');

test.after(async () => {
    await database.closeDatabase();
    await rm(testDirectory, { recursive: true, force: true });
});

test('upgrades version 8 ranking history atomically without changing IDs, values, relationships or sequence', async () => {
    // Build an actual version 8 library before invoking the current loader.
    for (const version of migrationVersions.slice(0, -1)) {
        await database.transaction(async () => {
            await database.exec(await migrationSql(version));
            await database.run("INSERT INTO schema_migrations (version, appliedAt) VALUES (?, datetime('now'))", [version]);
        });
    }
    const timestamp = '2026-11-01T12:00:00.000Z';
    for (const [id, name, websiteUrl] of [
        [101, 'Golem', 'https://www.golem.de/'],
        [102, 'WinFuture', 'https://winfuture.de/'],
        [103, 'ComputerBase', 'https://www.computerbase.de/'],
    ]) {
        await database.run(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)`, [id, name, websiteUrl, websiteUrl, timestamp, timestamp]);
        await database.run(`INSERT INTO feeds (id, sourceId, feedUrl, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?)`, [id, id, `${websiteUrl}rss`, timestamp, timestamp]);
        await database.run(`INSERT INTO articles
            (id, feedId, externalId, title, url, canonicalUrl, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id + 100, id, name, `${name} RSS title`, `${websiteUrl}article`, `${websiteUrl}article`, name, timestamp, timestamp, timestamp, timestamp]);
    }
    const insertRanking = values => database.run(`INSERT INTO most_read
        (id, sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, values);
    for (const values of [
        [101, 101, 201, 'https://www.golem.de/article', null, 1, 'most_read', timestamp],
        [102, 101, 201, 'https://www.golem.de/article', 'Golem comments', 2, 'most_commented', timestamp],
        [103, 101, null, 'https://www.golem.de/older', 'Older Golem chart', 3, 'most_read', '2026-10-31T12:00:00.000Z'],
        [201, 102, 202, 'https://winfuture.de/article', 'WinFuture chart', 1, 'most_read', timestamp],
        [202, 102, null, 'https://winfuture.de/unmatched', 'Unmatched WinFuture chart', 4, 'most_commented', timestamp],
        [301, 103, 203, 'https://www.computerbase.de/article', 'ComputerBase chart', 5, 'most_read', timestamp],
        [9999, 103, null, 'https://www.computerbase.de/deleted', 'Deleted high ID', 6, 'most_read', timestamp],
    ]) await insertRanking(values);
    await database.run('DELETE FROM articles WHERE id = 203');
    await database.run('DELETE FROM most_read WHERE id = 9999');

    const history = await database.all('SELECT * FROM most_read ORDER BY id');
    assert.equal(history.find(row => row.id === 301).articleId, null);
    const sources = await database.all('SELECT * FROM sources ORDER BY id');
    const articles = await database.all('SELECT * FROM articles ORDER BY id');
    const columns = await database.all('PRAGMA table_info(most_read)');
    const foreignKeys = await database.all('PRAGMA foreign_key_list(most_read)');
    const schemaObjects = () => database.all("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'most_read' AND type IN ('index', 'trigger') ORDER BY name");
    const objects = await schemaObjects();
    for (const { name } of await database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'most_read'")) {
        const references = await database.all(`PRAGMA foreign_key_list("${name.replaceAll('"', '""')}")`);
        assert.equal(references.some(reference => reference.table === 'most_read'), false, `${name} references most_read`);
    }
    assert.deepEqual(await database.get("SELECT seq FROM sqlite_sequence WHERE name = 'most_read'"), { seq: 9999 });

    // Even a failure after the rebuild must restore the complete version 8 table.
    await assert.rejects(database.transaction(async () => {
        await database.exec(await migrationSql('0009_top_news.sql'));
        throw new Error('Expected migration rollback');
    }), /Expected migration rollback/);
    assert.deepEqual(await database.all('SELECT * FROM most_read ORDER BY id'), history);
    assert.deepEqual(await schemaObjects(), objects);
    assert.deepEqual(await database.get("SELECT seq FROM sqlite_sequence WHERE name = 'most_read'"), { seq: 9999 });
    await assert.rejects(insertRanking([null, 103, null, 'https://www.computerbase.de/editorial', null, 1, 'top_news', timestamp]), /CHECK constraint/);

    await database.initSchema();
    assert.deepEqual(await database.all('SELECT * FROM most_read ORDER BY id'), history);
    assert.deepEqual(await database.all('SELECT * FROM sources ORDER BY id'), sources);
    assert.deepEqual(await database.all('SELECT * FROM articles ORDER BY id'), articles);
    assert.deepEqual(await database.all('PRAGMA table_info(most_read)'), columns);
    assert.deepEqual(await database.all('PRAGMA foreign_key_list(most_read)'), foreignKeys);
    assert.deepEqual(await schemaObjects(), objects);
    assert.deepEqual(await database.get("SELECT seq FROM sqlite_sequence WHERE name = 'most_read'"), { seq: 9999 });
    assert.deepEqual(await database.all("SELECT name FROM sqlite_master WHERE name = 'most_read_rebuilt'"), []);
    assert.deepEqual(await database.all("SELECT name FROM sqlite_temp_master WHERE name = 'migration_0009_most_read_sequence'"), []);
    assert.equal((await insertRanking([null, 103, null, 'https://www.computerbase.de/editorial', 'Editorial selection', 1, 'top_news', timestamp])).lastID, 10000);
    const defaults = await database.run(`INSERT INTO most_read (sourceId, canonicalUrl, rank, capturedAt)
        VALUES (103, 'https://www.computerbase.de/default', 7, ?)`, [timestamp]);
    assert.equal((await database.get('SELECT rankingKey FROM most_read WHERE id = ?', [defaults.lastID])).rankingKey, 'most_read');
    for (const values of [
        [null, 103, null, 'https://www.computerbase.de/invalid', null, 1, 'invalid', timestamp],
        [null, 103, null, 'https://www.computerbase.de/zero', null, 0, 'top_news', timestamp],
        [null, 103, null, 'https://www.computerbase.de/duplicate-rank', null, 1, 'top_news', timestamp],
        [null, 103, null, 'https://www.computerbase.de/editorial', null, 2, 'top_news', timestamp],
        [null, 999, null, 'https://missing.test/article', null, 1, 'top_news', timestamp],
        [null, 103, 999, 'https://www.computerbase.de/missing-article', null, 8, 'top_news', timestamp],
    ]) await assert.rejects(insertRanking(values), /constraint/);

    const upgradedHistory = await database.all('SELECT * FROM most_read ORDER BY id');
    const sequence = await database.get("SELECT seq FROM sqlite_sequence WHERE name = 'most_read'");
    await database.initSchema();
    assert.deepEqual(await database.all('SELECT * FROM most_read ORDER BY id'), upgradedHistory);
    assert.deepEqual(await database.get("SELECT seq FROM sqlite_sequence WHERE name = 'most_read'"), sequence);
    await database.run('DELETE FROM articles WHERE id = 201');
    assert.equal((await database.get('SELECT articleId FROM most_read WHERE id = 101')).articleId, null);
    assert.equal((await database.get('SELECT articleId FROM most_read WHERE id = 102')).articleId, null);
    await database.run('DELETE FROM sources WHERE id = 102');
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM most_read WHERE sourceId = 102')).count, 0);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM most_read WHERE sourceId = 103')).count, 3);
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
    await database.run('DELETE FROM sources WHERE id IN (101, 103)');
});

test('preserves a deleted AUTOINCREMENT high-water mark when the version 8 ranking table is empty', async () => {
    await database.exec('DROP TABLE most_read');
    await database.exec(await migrationSql('0008_most_read.sql'));
    await database.run("DELETE FROM schema_migrations WHERE version = '0009_top_news.sql'");
    await database.exec(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES (104, 'Empty library fixture', 'https://empty.test/', 'https://empty.test/', datetime('now'), datetime('now'));
        INSERT INTO most_read (id, sourceId, canonicalUrl, rank, capturedAt)
        VALUES (20000, 104, 'https://empty.test/deleted', 1, '2026-11-01T12:00:00.000Z');
        DELETE FROM most_read;`);
    await database.initSchema();
    assert.deepEqual(await database.all('SELECT * FROM most_read'), []);
    assert.deepEqual(await database.get("SELECT seq FROM sqlite_sequence WHERE name = 'most_read'"), { seq: 20000 });
    const result = await database.run(`INSERT INTO most_read (sourceId, canonicalUrl, rank, rankingKey, capturedAt)
        VALUES (104, 'https://empty.test/editorial', 1, 'top_news', '2026-11-01T12:00:00.000Z')`);
    assert.equal(result.lastID, 20001);
    await database.run('DELETE FROM sources WHERE id = 104');
});

test('applies versioned migrations in order and only once', async () => {
    await database.initSchema();

    assert.deepEqual(
        await database.all('SELECT version FROM schema_migrations ORDER BY version'),
        migrationVersions.map(version => ({ version })),
    );

    const feedColumns = await database.all('PRAGMA table_info(feeds)');
    assert.equal(feedColumns.some(column => column.name === 'name'), true);
    assert.equal((await database.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'bullshit_rules'")).count, 1);
    assert.equal((await database.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'article_bullshit_matches'")).count, 1);
    assert.deepEqual(
        await database.all('SELECT name, enabled, field, operator, value FROM bullshit_rules ORDER BY id'),
        [
            { name: 'Black Friday', enabled: 0, field: 'title', operator: 'contains', value: 'Black Friday' },
            { name: 'Sponsored', enabled: 0, field: 'title', operator: 'contains', value: 'Sponsored' },
            { name: 'Deals', enabled: 0, field: 'url', operator: 'contains', value: '/deals/' },
            { name: 'SEO List', enabled: 0, field: 'title', operator: 'regex', value: '^Die \\d+' },
        ],
    );

    await database.initSchema();

    assert.deepEqual(await database.get('SELECT COUNT(*) AS count FROM schema_migrations'), { count: 9 });
    assert.deepEqual(await database.get('PRAGMA integrity_check'), { integrity_check: 'ok' });
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
});

test('preserves legacy word filters as enabled rules and matches without losing feed exclusions', async () => {
    // Recreate the previous schema's settings and mark only the new migration pending.
    await database.exec(`CREATE TABLE digest_blocked_words (
        id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE COLLATE NOCASE, createdAt TEXT NOT NULL
    );
    INSERT INTO digest_blocked_words VALUES (1, 'Affiliate', datetime('now')), (2, 'Noise', datetime('now'));
    DELETE FROM schema_migrations WHERE version = '0005_unified_digest_filters.sql';
    INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES (1, 'Example', 'https://example.test', 'https://example.test/', datetime('now'), datetime('now'));
    INSERT INTO feeds (id, sourceId, feedUrl, createdAt, updatedAt)
        VALUES (1, 1, 'https://example.test/rss', datetime('now'), datetime('now'));
    INSERT INTO digest_excluded_feeds VALUES (1, datetime('now'));
    INSERT INTO bullshit_rules (name, enabled, field, operator, value, createdAt, updatedAt) VALUES
        ('Existing noise rule', 1, 'title', 'contains', 'noise', datetime('now'), datetime('now')),
        ('Disabled noise rule', 0, 'teaser', 'contains', 'Noise', datetime('now'), datetime('now'));
    INSERT INTO articles (feedId, externalId, title, teaser, contentHash, publishedAt, fetchedAt, createdAt, updatedAt) VALUES
        (1, 'title', 'AFFILIATE report', '', 'a', datetime('now'), datetime('now'), datetime('now'), datetime('now')),
        (1, 'teaser', 'Report', 'Affiliate recommendation', 'b', datetime('now'), datetime('now'), datetime('now'), datetime('now')),
        (1, 'noise', 'Noise report', '', 'c', datetime('now'), datetime('now'), datetime('now'), datetime('now'));
    `);
    await database.initSchema();
    assert.equal(await database.get("SELECT name FROM sqlite_master WHERE name = 'digest_blocked_words'"), undefined);
    const rules = await database.all("SELECT name, enabled, field, value FROM bullshit_rules WHERE value COLLATE NOCASE IN ('Affiliate', 'Noise') ORDER BY id");
    assert.equal(rules.length, 5);
    assert.equal(rules.find(rule => rule.name === 'Disabled noise rule').enabled, 0);
    assert.equal(rules.filter(rule => rule.enabled && rule.field === 'title' && rule.value.toLowerCase() === 'noise').length, 1);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM article_bullshit_matches')).count, 3);
    assert.deepEqual(await database.all('SELECT feedId FROM digest_excluded_feeds'), [{ feedId: 1 }]);
    await database.initSchema();
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM article_bullshit_matches')).count, 3);
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
});

test('watchdog migration baselines an existing library without creating matches or notifications', async () => {
    const latest = (await database.get('SELECT MAX(id) AS id FROM articles')).id;
    await database.exec(`DROP TABLE watchdog_matches; DROP TABLE watchdogs;
        ALTER TABLE feeds DROP COLUMN watchdogInitializedAt;
        DELETE FROM app_metadata WHERE key LIKE 'watchdog.%';
        DELETE FROM schema_migrations WHERE version IN ('0006_watchdogs.sql', '0007_watchdog_export_index.sql');`);
    await database.initSchema();
    assert.equal(Number((await database.get("SELECT value FROM app_metadata WHERE key = 'watchdog.lastArticleId'")).value), latest);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM watchdog_matches')).count, 0);
    assert.equal((await database.get("SELECT value FROM app_metadata WHERE key = 'watchdog.notifications'")).value, '0');
    assert.ok((await database.get('SELECT watchdogInitializedAt FROM feeds WHERE id = 1')).watchdogInitializedAt);
    const plan = await database.all('EXPLAIN QUERY PLAN SELECT articleId FROM watchdog_matches WHERE articleId = ? AND archivedAt IS NULL', [latest]);
    assert.ok(plan.some(row => row.detail.includes('idx_watchdog_matches_article')));
});

test('concurrent transactions and unrelated queries cannot join a failing transaction', async () => {
    await database.exec('CREATE TABLE transaction_isolation_test (value TEXT)');
    const failing = database.transaction(async () => {
        await database.run("INSERT INTO transaction_isolation_test VALUES ('rolled back')");
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('Expected rollback');
    });
    const independent = database.run("INSERT INTO transaction_isolation_test VALUES ('retained')");
    const succeeding = database.transaction(async () => {
        await database.run("INSERT INTO transaction_isolation_test VALUES ('committed')");
    });
    await assert.rejects(failing, /Expected rollback/);
    await Promise.all([independent, succeeding]);
    assert.deepEqual(await database.all('SELECT value FROM transaction_isolation_test ORDER BY rowid'), [{ value: 'retained' }, { value: 'committed' }]);
});
