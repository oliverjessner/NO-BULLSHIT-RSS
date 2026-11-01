import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-most-read-'));
process.env.DB_PATH = path.join(directory, 'rankings.db');
const db = await import('../database/datenbank.js');
const { saveMostReadSnapshot, reconcileMostReadArticles, refreshMostReadRankings } = await import('./most-read.js');
const { readMostReadRankings } = await import('./most-read-reader.js');
const { readRankingRefreshStatus, RANKING_STATUS_KEY } = await import('./ranking-status.js');
const { getStoredDigestPayload } = await import('./digest-store.js');
const { readStoredDigestPayload } = await import('./digest-reader.js');
const { openReadOnlyDatabase } = await import('../../cli/lib/read-only-database.js');
await db.initSchema();

const firstCapture = '2026-10-31T20:00:00.000Z';
const nextCapture = '2026-10-31T20:05:00.000Z';
const url = slug => `https://www.golem.de/news/${slug}.html`;
const item = (slug, rank = 1) => ({ canonicalUrl: url(slug), title: `Title ${slug}`, rank });
const rankings = () => ({ most_read: [item('one', 1), item('two', 2)], most_commented: [item('three', 1)] });
const save = (extra = {}) => saveMostReadSnapshot({ sourceId: 101, capturedAt: firstCapture, rankings: rankings(), ...extra });

test.beforeEach(async () => {
    await db.run('DELETE FROM app_metadata WHERE key = ?', [RANKING_STATUS_KEY]);
    await db.exec(`DELETE FROM digest_periods; DELETE FROM sources; DELETE FROM bullshit_rules;
        INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt) VALUES
            (101, 'Golem', 'https://www.golem.de/', 'https://www.golem.de/', datetime('now'), datetime('now')),
            (102, 'Other', 'https://other.test/', 'https://other.test/', datetime('now'), datetime('now')),
            (103, 'Manual Golem', 'https://www.golem.de/manual', 'https://www.golem.de/manual', datetime('now'), datetime('now'));
        INSERT INTO feeds (id, sourceId, name, feedUrl, createdAt, updatedAt) VALUES
            (201, 101, 'Golem RSS', 'https://rss.golem.de/rss.php', datetime('now'), datetime('now')),
            (202, 101, 'Golem imports', 'nbs-import:https://www.golem.de', datetime('now'), datetime('now')),
            (203, 102, 'Other RSS', 'https://other.test/feed', datetime('now'), datetime('now')),
            (204, 103, 'Manual only', 'nbs-import:https://golem.de', datetime('now'), datetime('now'));`);
});

async function article(slug, feedId = 201, extra = {}) {
    const result = await db.run(`INSERT INTO articles
        (feedId, externalId, title, teaser, content, url, canonicalUrl, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
        VALUES (?, ?, ?, 'Teaser', 'Article body', ?, ?, 'fixture', ?, ?, ?, ?)`,
    [feedId, `${slug}-${feedId}`, extra.title || `RSS ${slug}`, extra.url || url(slug), extra.canonicalUrl || url(slug),
        firstCapture, firstCapture, firstCapture, firstCapture]);
    return Number(result.lastID);
}

test('stores both lists atomically and idempotently, matches only the same source and prefers real RSS', async () => {
    await article('one', 203);
    const rssId = await article('one');
    await article('one', 202);
    assert.deepEqual(await save(), { inserted: 3, capturedAt: firstCapture });
    assert.deepEqual(await save(), { inserted: 0, capturedAt: firstCapture });
    assert.equal((await db.get("SELECT articleId FROM most_read WHERE rankingKey = 'most_read' AND rank = 1")).articleId, rssId);
    assert.equal((await db.get("SELECT articleId FROM most_read WHERE rankingKey = 'most_read' AND rank = 2")).articleId, null);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
    await assert.rejects(save({ rankings: { most_read: [item('different')], most_commented: [item('three')] } }), /already exists/);
    await assert.rejects(save({ capturedAt: nextCapture, rankings: { most_read: [item('one')] } }), /Both complete/);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
});

test('rolls back the entire capture if a later ranking insert fails', async () => {
    await save();
    await db.exec(`CREATE TRIGGER reject_ranking_fixture BEFORE INSERT ON most_read
        WHEN NEW.rankingKey = 'most_commented' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    try {
        await assert.rejects(save({ capturedAt: nextCapture }), /fixture failure/);
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
    } finally { await db.exec('DROP TRIGGER reject_ranking_fixture'); }
});

test('reconciles later and legacy tracked RSS URLs without rewriting historical captures', async () => {
    const manualId = await article('one', 202);
    await save();
    await save({ capturedAt: nextCapture });
    const rssId = await article('one', 201, { url: `${url('one')}?utm_source=legacy#top`, canonicalUrl: `${url('one')}?utm_source=legacy` });
    assert.equal(await reconcileMostReadArticles(), 1);
    assert.equal((await db.get("SELECT articleId FROM most_read WHERE capturedAt = ? AND rankingKey = 'most_read' AND rank = 1", [firstCapture])).articleId, manualId);
    assert.equal((await db.get("SELECT articleId FROM most_read WHERE capturedAt = ? AND rankingKey = 'most_read' AND rank = 1", [nextCapture])).articleId, rssId);
    assert.equal(await reconcileMostReadArticles(), 0);
    const groups = await readMostReadRankings(db);
    const group = groups.find(group => group.rankingKey === 'most_read');
    assert.equal(group.capturedAt, nextCapture);
    assert.equal(group.items[0].article.id, rssId);
    assert.equal(group.items[0].article.url, url('one'));
    assert.equal(group.items[1].article, null);
});

test('filters excluded feeds and Bullshit matches immediately while preserving original ranks and external links', async () => {
    const cleanId = await article('one');
    const noisyId = await article('two');
    await db.run(`INSERT INTO feeds (id, sourceId, name, feedUrl, createdAt, updatedAt)
        VALUES (205, 101, 'Golem subset', 'https://rss.golem.de/subset', datetime('now'), datetime('now'))`);
    await article('three', 205);
    await db.run("INSERT INTO digest_excluded_feeds VALUES (205, datetime('now'))");
    const rule = await db.run(`INSERT INTO bullshit_rules (name, enabled, field, operator, value, createdAt, updatedAt)
        VALUES ('Fixture', 1, 'title', 'contains', 'two', datetime('now'), datetime('now'))`);
    await db.run("INSERT INTO article_bullshit_matches VALUES (?, ?, datetime('now'))", [noisyId, rule.lastID]);
    await save({ rankings: { most_read: [item('one', 1), item('two', 2), item('unmatched', 3)], most_commented: [item('three')] } });
    const groups = await readMostReadRankings(db);
    const read = groups.find(group => group.rankingKey === 'most_read');
    assert.deepEqual(read.items.map(item => item.rank), [1, 3]);
    assert.equal(read.items[0].articleId, cleanId);
    assert.equal(read.items[1].articleId, null);
    assert.equal(groups.find(group => group.rankingKey === 'most_commented').items.length, 0);
    await db.run("INSERT INTO digest_excluded_feeds VALUES (201, datetime('now'))");
    assert.deepEqual(await readMostReadRankings(db), []);
});

test('matches raw functional query bytes as well as a legacy canonical URL that reserialized them', async () => {
    const raw = `${url('encoded')}?id=a%20b`;
    const id = await article('encoded', 201, { url: raw, canonicalUrl: `${url('encoded')}?id=a+b` });
    await save({ rankings: { most_read: [{ canonicalUrl: raw, title: 'Encoded', rank: 1 }], most_commented: [item('three')] } });
    assert.equal((await db.get("SELECT articleId FROM most_read WHERE rankingKey = 'most_read'")).articleId, id);
    const read = (await readMostReadRankings(db)).find(group => group.rankingKey === 'most_read');
    assert.equal(read.items[0].articleId, id);
    assert.equal(read.items[0].canonicalUrl, raw);
    assert.equal(read.items[0].article.url, raw);
});

test('failed/partial publisher captures preserve the last good snapshot and skip manual/unsupported sources', async () => {
    await save();
    let calls = 0;
    assert.deepEqual(await refreshMostReadRankings({ capture: async () => { calls += 1; throw new Error('Consent page'); } }), { updated: 0, total: 1 });
    assert.equal(calls, 1);
    assert.equal((await readRankingRefreshStatus(db)).state, 'error');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
    assert.deepEqual(await refreshMostReadRankings({ capture: async () => ({ capturedAt: nextCapture, rankings: { most_read: [item('one')] } }) }), { updated: 0, total: 1 });
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
});

test('ranking refresh status persists failures and clears them after a successful capture', async () => {
    await refreshMostReadRankings({ capture: async () => { throw new Error('could not launch Chromium'); } });
    assert.equal((await getStoredDigestPayload('day')).rankingStatus.state, 'error');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 0);
    await refreshMostReadRankings({ capture: async () => ({ capturedAt: firstCapture, rankings: rankings() }) });
    const status = await readRankingRefreshStatus(db);
    assert.equal(status.state, 'ready');
    assert.ok(status.attemptedAt);
    assert.equal(status.message, null);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
});

test('digest API data and independent read-only connections include latest rankings independently of the period', async () => {
    await article('one');
    await save();
    const independent = await openReadOnlyDatabase(process.env.DB_PATH);
    try {
        for (const variant of ['day', 'week', 'month']) {
            const current = await getStoredDigestPayload(variant, new Date('2026-10-01T12:00:00Z'));
            const readonly = await readStoredDigestPayload(variant, independent, new Date('2026-10-01T12:00:00Z'));
            assert.equal(current.rankings.length, 2);
            assert.deepEqual(readonly.rankings, current.rankings);
            assert.deepEqual(readonly.rankingStatus, current.rankingStatus);
            assert.equal(current.rankings[0].capturedAt, firstCapture);
        }
        assert.equal((await independent.get('SELECT total_changes() AS count')).count, 0);
    } finally { await independent.close(); }
});

test('old read-only databases without the new table return no rankings without querying article bodies', async () => {
    let queries = 0;
    assert.deepEqual(await readMostReadRankings({ all: async sql => {
        queries += 1;
        assert.match(sql, /sqlite_master/);
        return [];
    } }), []);
    assert.equal(queries, 1);
});

test('migration constraints, source deletion and article deletion preserve ranking history safely', async () => {
    const id = await article('one');
    await save();
    await assert.rejects(db.run(`INSERT INTO most_read (sourceId, canonicalUrl, rank, rankingKey, capturedAt)
        VALUES (101, ?, 0, 'most_read', ?)`, [url('invalid'), nextCapture]));
    await assert.rejects(db.run(`INSERT INTO most_read (sourceId, canonicalUrl, rank, rankingKey, capturedAt)
        VALUES (101, ?, 1, 'unknown', ?)`, [url('invalid'), nextCapture]));
    await db.run('DELETE FROM articles WHERE id = ?', [id]);
    assert.equal((await db.get("SELECT articleId FROM most_read WHERE rankingKey = 'most_read' AND rank = 1")).articleId, null);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
    await db.run('DELETE FROM sources WHERE id = 101');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 0);
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
});

test.after(async () => { await db.closeDatabase(); await rm(directory, { recursive: true, force: true }); });
