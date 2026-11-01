import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-most-read-'));
process.env.DB_PATH = path.join(directory, 'rankings.db');
const db = await import('../database/datenbank.js');
const { saveMostReadSnapshot, reconcileMostReadArticles, refreshMostReadRankings, isRankingRefreshRunning } = await import('./most-read.js');
const { readMostReadRankings } = await import('./most-read-reader.js');
const { readRankingRefreshStatus, RANKING_STATUS_KEY } = await import('./ranking-status.js');
const { getStoredDigestPayload } = await import('./digest-store.js');
const { readPublisherRankingsPayload } = await import('./publisher-rankings-reader.js');
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
        DELETE FROM app_metadata WHERE key LIKE 'rankings.refresh.status%';
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

async function winFutureSource() {
    await db.run(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES (301, 'WinFuture', 'https://winfuture.de/', 'https://winfuture.de/', datetime('now'), datetime('now'))`);
    await db.run(`INSERT INTO feeds (id, sourceId, name, feedUrl, createdAt, updatedAt)
        VALUES (401, 301, 'WinFuture RSS', 'https://static.winfuture.de/feeds/WinFuture-News-rss2.0.xml', datetime('now'), datetime('now'))`);
}
const winFutureRankings = () => ({
    most_read: [{ rank: 1, canonicalUrl: 'https://winfuture.de/news,162334.html', title: 'FritzOS 8.40' }],
    most_commented: [{ rank: 1, canonicalUrl: 'https://winfuture.de/news,162318.html', title: 'VW ID. Golf' }],
});

async function computerBaseSource() {
    await db.run(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES (501, 'ComputerBase', 'https://www.computerbase.de/', 'https://www.computerbase.de/', datetime('now'), datetime('now'))`);
    await db.run(`INSERT INTO feeds (id, sourceId, name, feedUrl, createdAt, updatedAt)
        VALUES (601, 501, 'ComputerBase RSS', 'https://www.computerbase.de/rss/news.xml', datetime('now'), datetime('now'))`);
}
const computerBaseUrl = 'https://www.computerbase.de/news/gaming/fixture.100081/';
const computerBaseRankings = () => ({ most_read: [{ rank: 1, canonicalUrl: computerBaseUrl, title: 'ComputerBase chart title' }] });

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
    const standalone = await readPublisherRankingsPayload('golem', db);
    assert.deepEqual(standalone.rankings.find(group => group.rankingKey === 'most_read').items.map(item => item.rank), [1, 3]);
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

test('ranking RSS cards expose live saved/read metadata and suppress dismissed articles in every group', async () => {
    const id = await article('one');
    await save({ rankings: { most_read: [item('one'), item('unmatched', 2)], most_commented: [item('one')] } });
    const list = await db.run("INSERT INTO lists (name,createdAt,updatedAt) VALUES ('Reading',datetime('now'),datetime('now'))");
    await db.run("INSERT INTO list_items VALUES (?,?,datetime('now'))", [list.lastID, id]);
    await db.run("INSERT INTO article_state (articleId,readAt,createdAt,updatedAt) VALUES (?,datetime('now'),datetime('now'),datetime('now'))", [id]);
    let groups = await readMostReadRankings(db);
    for (const group of groups) {
        const entry = group.items.find(item => item.articleId === id);
        assert.equal(entry.article.saved, true);
        assert.ok(entry.article.readAt);
        assert.equal(entry.article.title, 'RSS one');
        assert.equal(entry.article.teaser, 'Teaser');
        assert.equal(entry.article.content, 'Article body');
    }
    await db.run('DELETE FROM list_items WHERE articleId = ?', [id]);
    groups = await readMostReadRankings(db);
    assert.equal(groups[0].items[0].article.saved, false);
    await db.run("UPDATE article_state SET dismissedAt = datetime('now') WHERE articleId = ?", [id]);
    groups = await readMostReadRankings(db);
    assert.equal(groups.some(group => group.items.some(item => item.articleId === id)), false);
    assert.equal(groups.find(group => group.rankingKey === 'most_read').items[0].rank, 2);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3, 'Dismissal never changes the captured publisher history');
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
    assert.equal((await readPublisherRankingsPayload('golem', db)).rankingStatus.state, 'error');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 0);
    await refreshMostReadRankings({ capture: async () => ({ capturedAt: firstCapture, rankings: rankings() }) });
    const status = await readRankingRefreshStatus(db);
    assert.equal(status.state, 'ready');
    assert.ok(status.attemptedAt);
    assert.equal(status.message, null);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 3);
});

test('standalone publisher data is read-only and separate from Digest periods', async () => {
    await article('one');
    await save();
    const independent = await openReadOnlyDatabase(process.env.DB_PATH);
    try {
        const current = await readPublisherRankingsPayload('golem', db);
        const readonly = await readPublisherRankingsPayload('golem', independent);
        assert.equal(current.rankings.length, 2);
        assert.deepEqual(readonly, current);
        assert.equal(current.rankings[0].capturedAt, firstCapture);
        assert.deepEqual(current.media, [{ id: 'golem', name: 'Golem' }, { id: 'winfuture', name: 'WinFuture' }, { id: 'computerbase', name: 'ComputerBase' }]);
        assert.equal(current.configured, true);
        await assert.rejects(readPublisherRankingsPayload('other', independent), /Unsupported/);
        assert.equal(Object.hasOwn(await getStoredDigestPayload('day'), 'rankings'), false);
        assert.equal((await independent.get('SELECT total_changes() AS count')).count, 0);
    } finally { await independent.close(); }
});

test('concurrent manual and scheduled ranking refreshes share a single capture', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let captures = 0;
    const capture = async () => {
        captures += 1;
        await gate;
        return { capturedAt: firstCapture, rankings: rankings() };
    };
    const first = refreshMostReadRankings({ capture });
    const second = refreshMostReadRankings({ capture });
    assert.equal(isRankingRefreshRunning(), true);
    assert.equal(first, second);
    release();
    await Promise.all([first, second]);
    assert.equal(captures, 1);
    assert.equal(isRankingRefreshRunning(), false);
});

test('Golem consent failures retain an actionable typed status instead of generic retries', async () => {
    await refreshMostReadRankings({ capture: async () => {
        const error = new Error('Cookie choice required');
        error.code = 'GOLEM_CONSENT_REQUIRED';
        throw error;
    } });
    const status = await readRankingRefreshStatus(db);
    assert.equal(status.errorCode, 'GOLEM_CONSENT_REQUIRED');
    assert.match(status.message, /Automatic Golem consent could not be completed/);
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

test('dispatches WinFuture by source host and reuses atomic ranking history and RSS matching separately from Golem', async () => {
    await winFutureSource();
    const article = await db.run(`INSERT INTO articles (feedId, externalId, title, url, canonicalUrl, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
        VALUES (401, 'wf-fixture', 'WinFuture RSS story', 'https://winfuture.de/news,162334.html', 'https://winfuture.de/news,162334.html', 'fixture', ?, ?, ?, ?)`,
    [firstCapture, firstCapture, firstCapture, firstCapture]);
    const media = [];
    const result = await refreshMostReadRankings({ capture: async ({ medium }) => {
        media.push(medium);
        return { capturedAt: firstCapture, rankings: medium === 'golem' ? rankings() : winFutureRankings() };
    } });
    assert.deepEqual(media, ['golem', 'winfuture']);
    assert.deepEqual(result, { updated: 2, total: 2 });
    const payload = await readPublisherRankingsPayload('winfuture', db);
    assert.equal(payload.configured, true);
    assert.equal(payload.rankings.length, 2);
    assert.ok(payload.rankings.every(group => group.sourceId === 301));
    const read = payload.rankings.find(group => group.rankingKey === 'most_read');
    assert.equal(read.items[0].articleId, article.lastID);
    assert.equal(payload.rankings.find(group => group.rankingKey === 'most_commented').items[0].articleId, null);
    assert.ok((await readPublisherRankingsPayload('golem', db)).rankings.every(group => group.sourceId === 101));
});

test('manual WinFuture refresh captures only that medium and cannot postpone the all-publisher schedule or inherit legacy Golem failures', async () => {
    await winFutureSource();
    const legacy = JSON.stringify({ state: 'error', attemptedAt: firstCapture, errorCode: 'GOLEM_CONSENT_REQUIRED' });
    await db.run("INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, ?, datetime('now'))", [RANKING_STATUS_KEY, legacy]);
    assert.equal((await readRankingRefreshStatus(db, 'golem')).errorCode, 'GOLEM_CONSENT_REQUIRED');
    assert.equal((await readRankingRefreshStatus(db, 'winfuture')).state, 'idle');
    const captured = [];
    assert.deepEqual(await refreshMostReadRankings({ medium: 'winfuture', capture: async ({ medium }) => {
        captured.push(medium);
        return { capturedAt: firstCapture, rankings: winFutureRankings() };
    } }), { updated: 1, total: 1 });
    assert.deepEqual(captured, ['winfuture']);
    assert.equal((await readRankingRefreshStatus(db, 'winfuture')).state, 'ready');
    assert.equal((await readRankingRefreshStatus(db, 'winfuture')).errorCode, null);
    assert.equal((await db.get('SELECT value FROM app_metadata WHERE key = ?', [RANKING_STATUS_KEY])).value, legacy);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read WHERE sourceId = 101')).count, 0);
});

test('an all-publisher pass records independent outcomes when Golem fails and WinFuture succeeds', async () => {
    await winFutureSource();
    const result = await refreshMostReadRankings({ capture: async ({ medium }) => {
        if (medium === 'golem') {
            const error = new Error('Automatic Golem consent failed');
            error.code = 'GOLEM_CONSENT_REQUIRED';
            throw error;
        }
        return { capturedAt: firstCapture, rankings: winFutureRankings() };
    } });
    assert.deepEqual(result, { updated: 1, total: 2 });
    const golem = await readPublisherRankingsPayload('golem', db);
    const winfuture = await readPublisherRankingsPayload('winfuture', db);
    assert.equal(golem.rankingStatus.state, 'error');
    assert.equal(golem.rankingStatus.errorCode, 'GOLEM_CONSENT_REQUIRED');
    assert.equal(winfuture.rankingStatus.state, 'ready');
    assert.equal(winfuture.rankingStatus.errorCode, null);
    assert.equal(winfuture.rankings.length, 2);
    assert.equal((await readRankingRefreshStatus(db)).state, 'error');
    assert.ok((await readRankingRefreshStatus(db)).attemptedAt);
});

test('ComputerBase stores one complete most-read chart, matches RSS by source and reads it without creating another ranking', async () => {
    await computerBaseSource();
    await article('cross-source-cb', 203, { url: computerBaseUrl, canonicalUrl: computerBaseUrl });
    const rssId = await article('computerbase', 601, { url: `${computerBaseUrl}?utm_source=rss`, canonicalUrl: computerBaseUrl, title: 'ComputerBase RSS title' });
    const snapshot = { sourceId: 501, capturedAt: firstCapture, rankings: computerBaseRankings() };
    assert.deepEqual(await saveMostReadSnapshot(snapshot), { inserted: 1, capturedAt: firstCapture });
    assert.deepEqual(await saveMostReadSnapshot(snapshot), { inserted: 0, capturedAt: firstCapture });
    const readonly = await openReadOnlyDatabase(process.env.DB_PATH);
    try {
        const payload = await readPublisherRankingsPayload('computerbase', readonly);
        assert.equal(payload.configured, true);
        assert.equal(payload.rankings.length, 1);
        assert.equal(payload.rankings[0].rankingKey, 'most_read');
        assert.equal(payload.rankings[0].items[0].articleId, rssId);
        assert.equal(payload.rankings[0].items[0].article.title, 'ComputerBase RSS title');
        assert.equal(payload.rankings[0].items[0].article.teaser, 'Teaser');
        assert.equal((await readonly.get('SELECT total_changes() AS count')).count, 0);
    } finally { await readonly.close(); }
    await assert.rejects(saveMostReadSnapshot({ ...snapshot, capturedAt: nextCapture, rankings: {} }), /complete most-read/);
    await assert.rejects(saveMostReadSnapshot({ ...snapshot, capturedAt: nextCapture, rankings: {
        ...computerBaseRankings(), most_commented: computerBaseRankings().most_read,
    } }), /Invalid ranking keys/);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read WHERE sourceId = 501')).count, 1);
    assert.equal((await db.get('SELECT articleId FROM most_read WHERE sourceId = 501')).articleId, rssId);
});

test('ComputerBase refresh failures preserve its saved chart and manual refresh leaves the global eight-hour cadence unchanged', async () => {
    await computerBaseSource();
    await saveMostReadSnapshot({ sourceId: 501, capturedAt: firstCapture, rankings: computerBaseRankings() });
    const legacy = JSON.stringify({ state: 'ready', attemptedAt: firstCapture });
    await db.run("INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, ?, datetime('now'))", [RANKING_STATUS_KEY, legacy]);
    const captured = [];
    const result = await refreshMostReadRankings({ medium: 'computerbase', capture: async ({ medium }) => {
        captured.push(medium);
        return { capturedAt: nextCapture, rankings: { most_read: [] } };
    } });
    assert.deepEqual(captured, ['computerbase']);
    assert.deepEqual(result, { updated: 0, total: 1 });
    const payload = await readPublisherRankingsPayload('computerbase', db);
    assert.equal(payload.rankingStatus.state, 'error');
    assert.equal(payload.rankingStatus.errorCode, null);
    assert.equal(payload.rankings[0].capturedAt, firstCapture);
    assert.equal((await db.get('SELECT value FROM app_metadata WHERE key = ?', [RANKING_STATUS_KEY])).value, legacy);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read WHERE sourceId = 101')).count, 0);
});

test('the all-publisher schedule includes ComputerBase and preserves the two-list requirements for Golem and WinFuture', async () => {
    await computerBaseSource();
    await winFutureSource();
    const captured = [];
    const result = await refreshMostReadRankings({ capture: async ({ medium }) => {
        captured.push(medium);
        return { capturedAt: firstCapture, rankings: { golem: rankings(), winfuture: winFutureRankings(), computerbase: computerBaseRankings() }[medium] };
    } });
    assert.deepEqual(captured, ['golem', 'winfuture', 'computerbase']);
    assert.deepEqual(result, { updated: 3, total: 3 });
    for (const medium of captured) assert.equal((await readRankingRefreshStatus(db, medium)).state, 'ready');
    assert.equal((await readRankingRefreshStatus(db)).state, 'ready');
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM most_read')).count, 6);
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
