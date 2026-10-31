import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_FEEDS_MARKER, seedDefaultFeeds } from './default-feeds.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-default-feeds-'));
process.env.DB_PATH = path.join(directory, 'defaults.db');
const database = await import('../backend/database/datenbank.js');

test.before(async () => database.initSchema());
test.beforeEach(async () => {
    await database.run('DELETE FROM sources');
    await database.run('DELETE FROM app_metadata WHERE key = ?', [DEFAULT_FEEDS_MARKER]);
});
test.after(async () => {
    await database.closeDatabase();
    await rm(directory, { recursive: true, force: true });
});

test('new installations include the 40 production RSS feeds with their own names and functional query parameters', async () => {
    assert.deepEqual(await seedDefaultFeeds(database), { applied: true, sourcesAdded: 39, feedsAdded: 40 });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM feeds')).count, 40);
    assert.equal((await database.get("SELECT COUNT(*) AS count FROM feeds WHERE feedUrl LIKE 'nbs-import:%'")).count, 0);
    assert.deepEqual(await database.all(
        `SELECT feeds.name, feeds.feedUrl FROM feeds JOIN sources ON sources.id = feeds.sourceId
         WHERE sources.canonicalWebsiteUrl = 'https://www.businessinsider.de/' ORDER BY feeds.id`,
    ), [
        { name: 'businessinsider Tech', feedUrl: 'https://www.businessinsider.de/tech/feed/' },
        { name: 'businessinsider Startup', feedUrl: 'https://www.businessinsider.de/wirtschaft/startups/feed/' },
    ]);
    assert.equal((await database.get("SELECT feedUrl FROM feeds WHERE name = 'golem'")).feedUrl, 'https://rss.golem.de/rss.php?feed=RSS2.0');
    assert.equal((await database.get("SELECT feedUrl FROM feeds WHERE name = 'sueddeutsche-wirtschaft'")).feedUrl, 'https://rss.sueddeutsche.de/rss/Wirtschaft?format=rss');
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
});

test('adds missing defaults to a partly populated database without changing existing source or feed preferences', async () => {
    await database.exec(`INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES ('My Golem', 'https://www.golem.de/#reader', 'https://www.golem.de/', '2000-01-01', '2000-01-02');
        INSERT INTO feeds (sourceId, name, feedUrl, watchdogInitializedAt, createdAt, updatedAt)
        SELECT id, 'Personal news', 'https://rss.golem.de/rss.php?feed=RSS2.0', '2000-01-03', '2000-01-01', '2000-01-02'
        FROM sources;`);
    const sourceBefore = await database.get('SELECT * FROM sources');
    const feedBefore = await database.get('SELECT * FROM feeds');

    assert.deepEqual(await seedDefaultFeeds(database), { applied: true, sourcesAdded: 38, feedsAdded: 39 });
    assert.deepEqual(await database.get('SELECT * FROM sources WHERE id = ?', [sourceBefore.id]), sourceBefore);
    assert.deepEqual(await database.get('SELECT * FROM feeds WHERE id = ?', [feedBefore.id]), feedBefore);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM feeds')).count, 40);
});

test('keeps a feed moved to another website without creating an unused default source', async () => {
    await database.exec(`INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES ('Moved feed', 'https://custom.example/', 'https://custom.example/', '2000-01-01', '2000-01-01');
        INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
        SELECT id, 'My renamed feed', 'https://publisher.example/rss', '2000-01-01', '2000-01-01' FROM sources;`);
    const sources = [{ name: 'Default publisher', url: 'https://publisher.example/', hasFeed: true, feeds: ['https://publisher.example/rss'] }];

    assert.deepEqual(await seedDefaultFeeds(database, { sources }), { applied: true, sourcesAdded: 0, feedsAdded: 0 });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM sources')).count, 1);
    assert.equal((await database.get('SELECT name FROM feeds')).name, 'My renamed feed');
});

test('subsequent launches respect feeds intentionally deleted after the defaults were installed', async () => {
    await seedDefaultFeeds(database);
    await database.run("DELETE FROM sources WHERE canonicalWebsiteUrl = 'https://www.golem.de/'");

    assert.deepEqual(await seedDefaultFeeds(database), { applied: false, sourcesAdded: 0, feedsAdded: 0 });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM feeds')).count, 39);
    assert.equal(await database.get("SELECT id FROM sources WHERE canonicalWebsiteUrl = 'https://www.golem.de/'"), undefined);
});

test('a failed seed rolls back its rows and completion marker so the next launch can retry', async () => {
    await database.exec(`CREATE TRIGGER reject_default_feed BEFORE INSERT ON feeds
        WHEN NEW.feedUrl = 'https://www.heise.de/ix/feed.xml'
        BEGIN SELECT RAISE(ABORT, 'seed failure'); END;`);
    try {
        await assert.rejects(seedDefaultFeeds(database), /seed failure/);
        assert.equal((await database.get('SELECT COUNT(*) AS count FROM sources')).count, 0);
        assert.equal((await database.get('SELECT COUNT(*) AS count FROM feeds')).count, 0);
        assert.equal(await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_FEEDS_MARKER]), undefined);
    } finally {
        await database.exec('DROP TRIGGER reject_default_feed');
    }
    assert.equal((await seedDefaultFeeds(database)).feedsAdded, 40);
});
