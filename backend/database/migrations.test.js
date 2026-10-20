import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'no-bullshit-rss-migrations-'));
process.env.DB_PATH = path.join(testDirectory, 'migrations.sqlite');

const database = await import('./datenbank.js');

test.after(async () => {
    await database.closeDatabase();
    await rm(testDirectory, { recursive: true, force: true });
});

test('applies versioned migrations in order and only once', async () => {
    await database.initSchema();

    assert.deepEqual(
        await database.all('SELECT version FROM schema_migrations ORDER BY version'),
        [
            { version: '0001_schema.sql' },
            { version: '0002_feed_names.sql' },
            { version: '0003_bullshit_rules.sql' },
            { version: '0004_default_bullshit_rules.sql' },
            { version: '0005_unified_digest_filters.sql' },
            { version: '0006_watchdogs.sql' },
            { version: '0007_watchdog_export_index.sql' },
        ],
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

    assert.deepEqual(await database.get('SELECT COUNT(*) AS count FROM schema_migrations'), { count: 7 });
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
