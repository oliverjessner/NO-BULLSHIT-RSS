import assert from 'node:assert/strict';
import test from 'node:test';
import sqlite3 from '@vscode/sqlite3';
import { readAnalyticsMostRead, readAnalyticsRankingHistory } from './analytics-rankings.js';

const before = '2026-09-30T12:00:00.000Z';
const first = '2026-10-02T12:00:00.000Z';
const last = '2026-10-05T13:17:00.000Z';
const articleUrl = name => `https://publisher.test/${name}`;
const options = extra => ({ period: '30d', startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z',
    publisherId: null, rankingKey: null, topic: null, timeBasis: 'publishedAt', limit: 100, offset: 0, ...extra });

async function fixture({ empty = false } = {}) {
    const connection = new sqlite3.Database(':memory:');
    const invoke = (method, sql, params = []) => new Promise((resolve, reject) => connection[method](sql, params, function (error, result) {
        if (error) reject(error); else resolve(result ?? this);
    }));
    const database = { all: (sql, params) => invoke('all', sql, params), get: (sql, params) => invoke('get', sql, params),
        run: (sql, params) => invoke('run', sql, params), exec: sql => new Promise((resolve, reject) => connection.exec(sql, error => error ? reject(error) : resolve())),
        close: () => new Promise((resolve, reject) => connection.close(error => error ? reject(error) : resolve())) };
    await database.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE feeds (id INTEGER PRIMARY KEY, sourceId INTEGER);
        CREATE TABLE articles (id INTEGER PRIMARY KEY, feedId INTEGER, title TEXT, canonicalUrl TEXT, url TEXT, publishedAt TEXT, fetchedAt TEXT);
        CREATE INDEX idx_article_canonical ON articles (canonicalUrl);
        CREATE TABLE topics (id INTEGER PRIMARY KEY, slug TEXT, label TEXT);
        CREATE TABLE article_topics (articleId INTEGER, topicId INTEGER, PRIMARY KEY(articleId, topicId));
        CREATE TABLE most_read (id INTEGER PRIMARY KEY, sourceId INTEGER, articleId INTEGER, canonicalUrl TEXT, title TEXT, rank INTEGER, rankingKey TEXT, capturedAt TEXT,
            UNIQUE(sourceId,rankingKey,capturedAt,rank), UNIQUE(sourceId,rankingKey,capturedAt,canonicalUrl));
        CREATE INDEX idx_ranking_latest ON most_read (sourceId, rankingKey, capturedAt DESC, rank);`);
    if (!empty) {
        await database.exec(`INSERT INTO sources VALUES(1,'Publisher'),(2,'Second'),(3,'Unsupported');
            INSERT INTO feeds VALUES(11,1),(12,1),(21,2),(31,3);
            INSERT INTO topics VALUES(1,'tech','Technology'),(2,'policy','Policy');`);
        for (const [id, feedId, slug, date] of [[1,11,'a','2026-10-01'],[2,11,'b','2026-10-03'],[3,11,'c','2026-10-04'],
            [4,11,'d','2026-09-01'],[5,11,'e','2026-10-04'],[6,21,'a','2026-10-03'],[7,12,'a','2026-10-01'],
            [8,11,'unranked','2026-10-05'],[9,31,'unsupported','2026-10-05'],[10,11,'editorial','2026-10-05']]) {
            await database.run('INSERT INTO articles VALUES(?,?,?,?,?,?,?)', [id,feedId,`Article ${slug}`,articleUrl(slug),articleUrl(slug),`${date}T00:00:00.000Z`,last]);
        }
        for (const [id, topic] of [[1,1],[1,2],[2,1],[3,2],[4,1],[5,1],[6,1],[7,1],[8,1],[9,1],[10,1]]) {
            await database.run('INSERT INTO article_topics VALUES(?,?)', [id,topic]);
        }
        const rank = (sourceId, timestamp, key, slug, position, articleId) => database.run(
            'INSERT INTO most_read(sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES(?,?,?,?,?,?,?)',
            [sourceId,articleId,articleUrl(slug),`Stored ${slug}`,position,key,timestamp]);
        for (const [timestamp,slug,position,id] of [[before,'a',8,1],[before,'b',2,2],[first,'a',8,1],[first,'b',2,2],[first,'d',5,4],
            [last,'a',3,1],[last,'c',1,3],[last,'e',4,null]]) await rank(1,timestamp,'most_read',slug,position,id);
        for (const [timestamp,slug,position,id] of [[first,'editorial',1,10],[first,'a',2,1],[last,'editorial',2,10],[last,'a',1,1]]) await rank(1,timestamp,'top_news',slug,position,id);
        await rank(1,first,'most_commented','b',1,2);
        await rank(2,'2026-10-04T08:00:00.000Z','most_read','a',1,6);
    }
    return database;
}

test('ranking KPIs count distinct canonical URLs, complete snapshots, and first ever entries', async t => {
    const db = await fixture(); t.after(() => db.close());
    const result = await readAnalyticsMostRead(db, options());
    assert.deepEqual(result.metrics, { uniqueRankedArticles: 6, newEntries: 4, numberOneArticles: 4, snapshots: 6, publishers: 2 });
    assert.equal(result.topPerformers.length, 9);
    assert.equal(result.topPerformers.find(row => row.canonicalUrl === articleUrl('e')).articleId, 5, 'formerly external records resolve to their current RSS match');
    assert.deepEqual(result.publishers.find(row => row.id === 1).rankingKeys, ['most_commented','most_read','top_news']);
    assert.equal(result.topPerformers.find(row => row.canonicalUrl === articleUrl('a') && row.sourceId === 1 && row.rankingKey === 'most_read').snapshotAppearances, 2);
    assert.match(result.methodology.limitations, /Empty captures/);
});

test('position changes use actual consecutive source/type snapshots and never invent previous ranks', async t => {
    const db = await fixture(); t.after(() => db.close());
    const result = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read' }));
    assert.equal(result.movements.climbers[0].canonicalUrl, articleUrl('a'));
    assert.equal(result.movements.climbers[0].change, 5);
    assert.equal(result.movements.climbers[0].previousCapturedAt, first);
    assert.equal(result.movements.climbers[0].capturedAt, last);
    assert.deepEqual(result.movements.newEntries.map(row => row.canonicalUrl).sort(), [articleUrl('c'), articleUrl('e')]);
    assert.ok(result.movements.newEntries.every(row => row.previousRank === null && row.change === null));
    assert.deepEqual(result.movements.droppedOut.map(row => row.canonicalUrl).sort(), [articleUrl('b'),articleUrl('d')]);
    assert.ok(result.movements.droppedOut.every(row => row.currentRank === null && row.change === null));
    const commented = await readAnalyticsMostRead(db, options({ rankingKey: 'most_commented' }));
    assert.equal(commented.movements.unavailable.length, 1);
    assert.equal(commented.movements.newEntries.length, 0, 'one snapshot cannot establish a new entry between captures');
});

test('previous capture may precede period and topic filtering preserves the actual snapshot universe', async t => {
    const db = await fixture(); t.after(() => db.close());
    const result = await readAnalyticsMostRead(db, options({ startAt: '2026-10-03T00:00:00.000Z', publisherId: 1, rankingKey: 'most_read', topic: 'tech' }));
    assert.equal(result.metrics.snapshots, 1);
    assert.equal(result.movements.climbers[0].previousCapturedAt, first);
    assert.equal(result.movements.climbers[0].change, 5);
    assert.deepEqual(result.movements.droppedOut.map(row => row.canonicalUrl).sort(), [articleUrl('b'),articleUrl('d')]);
    assert.deepEqual(result.movements.newEntries.map(row => row.canonicalUrl), [articleUrl('e')]);
    assert.equal(result.metrics.newEntries, 1, 'a previously observed URL is not a first-ever entry in a later period');
    const policy = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read', topic: 'policy' }));
    assert.equal(policy.metrics.uniqueRankedArticles, 2);
    assert.equal(policy.movements.climbers.length, 1);
    assert.equal(policy.movements.newEntries.length, 1);
});

test('ranking histories retain nulls for observed absence and do not synthesize collection gaps', async t => {
    const db = await fixture(); t.after(() => db.close());
    const result = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('b') }));
    assert.equal(result.article.articleId, 2);
    assert.deepEqual(result.series.find(row => row.rankingKey === 'most_read').points, [
        { capturedAt: first, rank: 2 }, { capturedAt: last, rank: null },
    ]);
    assert.deepEqual(result.series.map(row => row.rankingKey).sort(), ['most_commented','most_read']);
    assert.equal(result.series.find(row => row.rankingKey === 'most_read').statistics.snapshotAppearances, 1);
    assert.equal(result.series.find(row => row.rankingKey === 'most_read').statistics.observedSpanMs, 0);
    assert.equal(result.pagination.total, 3);
    const external = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('e') }));
    assert.equal(external.article.title, 'Stored e');
    assert.equal(external.article.articleId, 5);
    const filtered = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('a'), rankingKey: 'top_news' }));
    assert.deepEqual(filtered.series.map(row => row.rankingKey), ['top_news']);
    assert.equal(filtered.series[0].statistics.latestRank, 1);
    assert.equal(filtered.series[0].statistics.observedSpanMs, Date.parse(last)-Date.parse(first));
    await db.run('INSERT INTO most_read(sourceId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES(?,?,?,?,?,?)',
        [1,articleUrl('external'),'External headline',10,'most_read',last]);
    const unmatched = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('external') }));
    assert.equal(unmatched.article.articleId, null);
    assert.equal(unmatched.article.title, 'External headline');
});

test('all topic matches dropping out of the latest snapshot remain dropped rather than becoming a stale snapshot', async t => {
    const db = await fixture(); t.after(() => db.close());
    await db.exec("INSERT INTO topics VALUES(3,'archive','Archive'); INSERT INTO article_topics VALUES(2,3)");
    const result = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read', topic: 'archive' }));
    assert.equal(result.metrics.snapshots, 2);
    assert.equal(result.movements.droppedOut.length, 1);
    assert.equal(result.movements.droppedOut[0].capturedAt, last);
    assert.equal(result.movements.droppedOut[0].previousCapturedAt, first);
    assert.equal(result.movements.unchanged.length, 0);
    const history = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('b'), topic: 'archive', rankingKey: 'most_read' }));
    assert.equal(history.series[0].points.at(-1).rank, null);
});

test('stale links to another publisher cannot add its local article or topics', async t => {
    const db = await fixture(); t.after(() => db.close());
    await db.exec("INSERT INTO topics VALUES(3,'foreign','Foreign-only'); INSERT INTO article_topics VALUES(9,3)");
    await db.run('INSERT INTO most_read(sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES(?,?,?,?,?,?,?)',
        [1,9,articleUrl('foreign-external'),'External article',9,'most_read',last]);
    const result = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read', topic: 'foreign' }));
    assert.equal(result.metrics.uniqueRankedArticles, 0);
    const history = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('foreign-external') }));
    assert.equal(history.article.articleId, null);
    assert.equal(history.article.title, 'External article');
});

test('UTC boundaries are half open and mixed SQLite/ISO capture timestamps sort chronologically', async t => {
    const db = await fixture(); t.after(() => db.close());
    await db.run('UPDATE most_read SET capturedAt = ? WHERE sourceId = 1 AND capturedAt = ?', ['2026-10-02 12:00:00',first]);
    await db.run('INSERT INTO most_read(sourceId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES(?,?,?,?,?,?)',
        [1,articleUrl('future'),'Future',9,'most_read','2026-11-01T00:00:00.000Z']);
    const result = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read', sort: 'count', direction: 'desc' }));
    assert.equal(result.topPerformers[0].bestRank, 1, 'generic default sorting must not put the worst ranking first');
    assert.equal(result.metrics.uniqueRankedArticles, 5);
    assert.equal(result.metrics.snapshots, 2, 'capture exactly at the exclusive end is excluded');
    assert.equal(result.movements.climbers[0].previousCapturedAt, first);
    const bounded = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read',
        startAt: '2026-10-02T12:00:00.000Z', endAt: '2026-10-05T13:17:00.000Z' }));
    assert.equal(bounded.metrics.snapshots, 1);
    assert.equal(bounded.topPerformers.find(row => row.canonicalUrl === articleUrl('a')).firstCaptured, first);
    assert.equal(bounded.topPerformers.find(row => row.canonicalUrl === articleUrl('a')).latestRank, 8);
});

test('all time, decliners, and unchanged positions retain distinct ranking types', async t => {
    const db = await fixture(); t.after(() => db.close());
    const all = await readAnalyticsMostRead(db, options({ period: 'all', startAt: null }));
    assert.equal(all.metrics.snapshots, 7);
    assert.equal(all.metrics.newEntries, 6);
    assert.equal(all.movements.decliners.find(row => row.rankingKey === 'top_news').change, -1);
    await db.run('INSERT INTO most_read(sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES(?,?,?,?,?,?,?)',
        [1,1,articleUrl('a'),'Stored a',3,'most_read','2026-10-06T00:00:00.000Z']);
    const next = await readAnalyticsMostRead(db, options({ publisherId: 1, rankingKey: 'most_read' }));
    assert.equal(next.movements.unchanged[0].change, 0);
    assert.equal(next.movements.unchanged[0].previousCapturedAt, last);
});

test('topic performance uses comparable publisher/type and article-time coverage with URL deduplication', async t => {
    const db = await fixture(); t.after(() => db.close());
    const result = await readAnalyticsMostRead(db, options({ rankingKey: 'most_read' }));
    const tech = result.topicPerformance.find(row => row.slug === 'tech');
    assert.equal(tech.rankedArticles, 4, 'a,b,d,e; canonical URL a counted once across two publishers');
    assert.equal(tech.appearances, 6, 'appearances stay separate by publisher and actual snapshot');
    assert.equal(tech.eligibleArticles, 5, 'a,b,e,unranked,editorial; duplicate RSS copies and unsupported publisher excluded');
    assert.equal(tech.eligibleRankedArticles, 3, 'old publication d is outside denominator and numerator');
    assert.equal(tech.share, 3 / 5);
    assert.equal(tech.coveredPublishers, 2);
    const all = await readAnalyticsMostRead(db, options());
    assert.deepEqual(all.topicPerformance.filter(row => row.slug === 'tech').map(row => row.rankingKey).sort(), ['most_commented','most_read','top_news']);
    assert.equal(all.topicPerformance.find(row => row.slug === 'tech' && row.rankingKey === 'top_news').eligibleRankedArticles, 2);
});

test('ranking output is deterministic, sorted, bounded, injection safe, and handles zero data', async t => {
    const db = await fixture(); t.after(() => db.close());
    const page = await readAnalyticsMostRead(db, options({ sort: 'snapshotAppearances', direction: 'desc', limit: 2, offset: 1 }));
    assert.equal(page.topPerformers.length, 2);
    assert.equal(page.pagination.hasMore, true);
    assert.equal(page.topPerformers[0].snapshotAppearances, 2);
    const safe = await readAnalyticsMostRead(db, options({ topic: "tech' OR 1=1 --", sort: 'rank; DROP TABLE articles', direction: 'desc;--' }));
    assert.equal(safe.metrics.uniqueRankedArticles, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM articles')).count, 10);
    const pageHistory = await readAnalyticsRankingHistory(db, options({ sourceId: 1, url: articleUrl('b'), historyLimit: 1 }));
    assert.equal(pageHistory.series.flatMap(row => row.points).length, 1);
    assert.equal(pageHistory.series.flatMap(row => row.points)[0].capturedAt, last, 'history pages begin with most recent actual captures');
    assert.equal(pageHistory.pagination.hasMore, true);
    const empty = await fixture({ empty: true }); t.after(() => empty.close());
    const zero = await readAnalyticsMostRead(empty, options());
    assert.deepEqual(zero.metrics, { uniqueRankedArticles: 0, newEntries: 0, numberOneArticles: 0, snapshots: 0, publishers: 0 });
    assert.deepEqual(zero.topPerformers, []);
    assert.deepEqual(zero.topicPerformance, []);
    assert.deepEqual((await readAnalyticsRankingHistory(empty, options({ sourceId: 1, url: articleUrl('a') }))).series, []);
});
