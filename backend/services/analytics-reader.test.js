import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsFixture, addAnalyticsArticle } from './analytics-fixture.js';
import { normalizeAnalyticsFilters } from './analytics-filters.js';
import { readAnalyticsOverview, readAnalyticsTrends, readAnalyticsPublishers, readAnalyticsTopics, readAnalyticsLibrary } from './analytics-reader.js';

const options = input => normalizeAnalyticsFilters({ period: '7d', ...input }, { now: new Date('2026-11-10T12:00:00Z') });
const fixture = async (t, config) => { const database = await analyticsFixture(config); t.after(() => database.close()); return database; };

test('overview counts distinct article state, topic, and ranking associations without multiplying articles', async t => {
    const db = await fixture(t);
    const result = await readAnalyticsOverview(db, options());
    assert.deepEqual(result.kpis, { totalArticles: 8, periodArticles: 4, bullshitArticles: 1, activeFeeds: 4, savedArticles: 1, readArticles: 1, rankedArticles: 3 });
    assert.deepEqual(result.topTopics.map(row => [row.slug, row.count, row.share]), [['ai', 4, 100], ['climate', 1, 25], ['tech', 1, 25]]);
    assert.equal(result.topFeeds.reduce((sum, row) => sum + row.count, 0), 4);
    assert.deepEqual(result.volume.filter(row => row.count), [{ bucket: '2026-11-06', count: 1 }, { bucket: '2026-11-08', count: 2 }, { bucket: '2026-11-09', count: 1 }]);
    assert.equal(result.volume.find(row => row.bucket === '2026-11-07').count, 0);
    assert.deepEqual(result.metadata.coverage.volume, { returned: 8, total: 8, truncated: false, observedBuckets: 3 });
    assert.equal(result.metadata.timezone, 'UTC');
});

test('publisher, topic, UTC boundary, and selected timestamp filters apply to all aggregations', async t => {
    const db = await fixture(t);
    const result = await readAnalyticsOverview(db, options({ publisher: 1, topic: 'ai' }));
    assert.equal(result.kpis.periodArticles, 2);
    assert.equal(result.kpis.totalArticles, 3);
    assert.equal(result.kpis.activeFeeds, 2);
    assert.equal(result.topFeeds.length, 2);
    await addAnalyticsArticle(db, { id: 9, publishedAt: '2026-11-03T12:00:00.000Z', fetchedAt: '2026-11-10T12:00:00.000Z', topics: [1] });
    await addAnalyticsArticle(db, { id: 10, publishedAt: '2026-11-03T11:59:59.999Z', fetchedAt: '2026-11-09T12:00:00.000Z', topics: [1] });
    assert.equal((await readAnalyticsOverview(db, options())).kpis.periodArticles, 5);
    assert.equal((await readAnalyticsOverview(db, options({ basis: 'fetchedAt' }))).kpis.periodArticles, 5);
});

test('week and month groups use UTC calendar bucket boundaries', async t => {
    const db = await fixture(t);
    assert.deepEqual((await readAnalyticsOverview(db, options({ group: 'week' }))).volume, [{ bucket: '2026-11-02', count: 3 }, { bucket: '2026-11-09', count: 1 }]);
    assert.deepEqual((await readAnalyticsOverview(db, options({ group: 'month' }))).volume, [{ bucket: '2026-11-01', count: 4 }]);
});

test('trends compare equal adjacent periods with deterministic emergence and zero-baseline handling', async t => {
    const db = await fixture(t);
    for (let id = 9; id < 14; id += 1) await addAnalyticsArticle(db, { id, topics: [4] });
    const result = await readAnalyticsTrends(db, options({ topics: 'ai,emerging' }));
    assert.equal(result.topicSeries.length, 2);
    const newTopic = result.momentum.find(row => row.slug === 'emerging');
    assert.deepEqual([newTopic.previous, newTopic.current, newTopic.change, newTopic.percentChange, newTopic.emerging], [0, 5, 5, null, true]);
    const tech = result.momentum.find(row => row.slug === 'tech');
    assert.deepEqual([tech.previous, tech.current, tech.change, tech.percentChange, tech.emerging], [1, 1, 0, 0, false]);
    assert.deepEqual(result.emerging.map(row => row.slug), ['emerging']);
    const allTime = await readAnalyticsTrends(db, options({ period: 'all' }));
    assert.deepEqual(allTime.momentum, []);
    assert.equal(allTime.metadata.momentum.available, false);
});

test('publisher and feed rows stay separate and unsupported rankings are unavailable', async t => {
    const db = await fixture(t);
    const result = await readAnalyticsPublishers(db, options({ compare: '1,2' }));
    const golem = result.publishers.find(row => row.id === 1);
    assert.equal(golem.totalArticles, 3);
    assert.equal(golem.periodArticles, 1);
    assert.equal(golem.rankedArticles, 1);
    assert.equal(golem.bullshitRate, 100);
    assert.equal(golem.averagePerDay, 0.14);
    assert.equal(result.feeds.filter(row => row.publisherId === 1).length, 2);
    assert.equal(result.comparison.find(row => row.id === 1).volume.reduce((sum, point) => sum + point.count, 0), 1);
    assert.equal(result.feeds.filter(row => row.publisherId === 1).reduce((sum, row) => sum + row.periodArticles, 0), 2);
    const unsupported = result.publishers.find(row => row.id === 2);
    assert.equal(unsupported.rankingSupported, false);
    assert.equal(unsupported.rankedArticles, null);
    assert.equal(result.comparison.length, 2);
    assert.equal(result.comparison.find(row => row.id === 1).topics.find(row => row.slug === 'ai').count, 1);
    assert.deepEqual(result.comparison.find(row => row.id === 1).rankingAppearances, [
        { rankingKey: 'most_commented', articles: 1, appearances: 1 },
        { rankingKey: 'most_read', articles: 1, appearances: 3 },
    ]);
    assert.deepEqual(result.comparison.find(row => row.id === 2).rankingAppearances, []);
    assert.deepEqual(result.publishers.find(row => row.id === 3).rankingKeys, ['top_news']);
});

test('publisher filter selects configuration rows while explicit comparison retains the other publisher', async t => {
    const db = await fixture(t);
    const result = await readAnalyticsPublishers(db, options({ publisher: 1, compare: '1,2', topic: 'ai', sort: 'name', direction: 'asc' }));
    assert.deepEqual(result.publishers.map(row => row.id), [1]);
    assert.deepEqual(result.feeds.map(row => row.id), [1, 2]);
    assert.equal(result.comparison.find(row => row.id === 2).periodArticles, 1);
    const editorialFilter = await readAnalyticsPublishers(db, options({ rankingKey: 'top_news' }));
    assert.equal(editorialFilter.publishers.find(row => row.id === 1).rankedArticles, null);
    assert.equal(editorialFilter.publishers.find(row => row.id === 3).rankedArticles, 1);
});

test('topic distributions and cooccurrences count distinct articles and keep ranking types distinct', async t => {
    const db = await fixture(t);
    const result = await readAnalyticsTopics(db, options({ topic: 'ai' }));
    assert.deepEqual(result.kpis, { totalArticles: 4, rankedArticles: 3 });
    assert.equal(result.topics.find(row => row.slug === 'ai').count, 4);
    assert.equal(result.publishers.filter(row => row.slug === 'ai').reduce((sum, row) => sum + row.count, 0), 4);
    assert.deepEqual(result.cooccurrence.map(row => [row.leftSlug, row.rightSlug, row.count]), [['ai', 'climate', 1], ['ai', 'tech', 1]]);
    assert.deepEqual(result.rankings, [
        { rankingKey: 'most_commented', count: 2, appearances: 1 },
        { rankingKey: 'most_read', count: 2, appearances: 3 },
        { rankingKey: 'top_news', count: 1, appearances: 1 },
    ]);
});

test('library diagnostics use actual stored metadata and distinguish potential duplicates and unmatched rankings', async t => {
    const db = await fixture(t);
    const result = await readAnalyticsLibrary(db, options());
    assert.deepEqual(result.kpis, { totalArticles: 8, periodArticles: 4, readArticles: 1, unreadArticles: 3, savedArticles: 1, dismissedArticles: 1, unclassifiedArticles: 0, feeds: 5, publishers: 3 });
    assert.deepEqual(result.quality, { orphanRankingRecords: 1, duplicateUrlGroups: 1, duplicateUrlArticles: 2 });
    assert.deepEqual(result.classification, [{ status: 'ready', count: 4 }]);
    assert.equal(result.feedFreshness.length, 4);
    assert.equal(result.feedFreshness.find(row => row.id === 3).lastFetchedAt, '2026-11-11T10:00:00Z');
    assert.match(result.metadata.definitions.feedFreshness, /does not establish/);
    assert.equal((await readAnalyticsLibrary(db, options({ publisher: 2 }))).quality.orphanRankingRecords, 0);
});

test('empty installations return real zeros and empty bounded collections for every section', async t => {
    const db = await fixture(t, { seed: false });
    for (const read of [readAnalyticsOverview, readAnalyticsTrends, readAnalyticsPublishers, readAnalyticsTopics, readAnalyticsLibrary]) {
        const result = await read(db, options());
        for (const value of Object.values(result.kpis || {})) assert.equal(value, 0);
        for (const key of ['volume', 'topFeeds', 'topTopics', 'topicSeries', 'momentum', 'emerging', 'publishers', 'feeds', 'comparison', 'topics', 'cooccurrence', 'rankings', 'collection', 'classification', 'feedFreshness']) if (Array.isArray(result[key])) assert.deepEqual(result[key], []);
    }
});

test('reader methods only issue one parameterized aggregation statement and never select article bodies', async t => {
    const db = await fixture(t);
    const originalGet = db.get;
    const statements = [];
    db.get = (sql, params) => { statements.push({ sql, params }); return originalGet(sql, params); };
    for (const read of [readAnalyticsOverview, readAnalyticsTrends, readAnalyticsPublishers, readAnalyticsTopics, readAnalyticsLibrary]) await read(db, options({ publisher: 1, topic: 'ai' }));
    assert.equal(statements.length, 5);
    for (const { sql, params } of statements) {
        assert.equal(/\b(?:INSERT|UPDATE|DELETE|PRAGMA|content|teaser)\b/i.test(sql), false);
        assert.equal(sql.includes("'ai'"), false);
        assert.ok(params.includes('ai'));
        assert.ok(sql.includes('?'));
    }
});


test('unlinked ranking URLs resolve only within the correct publisher and duplicate records do not multiply appearances', async t => {
    const db = await fixture(t);
    await addAnalyticsArticle(db, { id: 9, feedId: 3, topics: [2], url: 'https://outside.test/same-url' });
    await addAnalyticsArticle(db, { id: 10, feedId: 1, topics: [3], url: 'https://golem.de/unlinked-local' });
    await db.exec(`INSERT INTO most_read (sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt) VALUES
        (1, NULL, 'https://outside.test/same-url', 'Other publisher article', 4, 'most_read', '2026-11-09T12:00:00Z'),
        (1, NULL, 'https://golem.de/unlinked-local', 'Local unlinked article', 5, 'most_read', '2026-11-09T12:00:00Z')`);
    assert.equal((await readAnalyticsOverview(db, options())).kpis.rankedArticles, 4);
    assert.equal((await readAnalyticsPublishers(db, options())).publishers.find(row => row.id === 1).rankedArticles, 2);
    assert.equal((await readAnalyticsLibrary(db, options())).quality.orphanRankingRecords, 2);
    const topics = await readAnalyticsTopics(db, options({ topic: 'tech' }));
    assert.deepEqual(topics.rankings.find(row => row.rankingKey === 'most_read'), { rankingKey: 'most_read', count: 2, appearances: 3 });
    assert.equal((await readAnalyticsOverview(db, options({ publisher: 2 }))).kpis.rankedArticles, 0);
});


test('calendar gap filling remains bounded and discloses truncated all-time volume', async t => {
    const db = await fixture(t);
    await addAnalyticsArticle(db, { id: 9, publishedAt: '2020-01-01T00:00:00Z', topics: [1] });
    const result = await readAnalyticsOverview(db, options({ period: 'all' }));
    assert.equal(result.volume.length, 512);
    assert.equal(result.metadata.coverage.volume.truncated, true);
    assert.ok(result.metadata.coverage.volume.total > 2000);
    assert.equal(result.volume.at(-1).bucket, '2026-11-09');
    const trends = await readAnalyticsTrends(db, options({ topics: 'ai,tech' }));
    assert.equal(trends.topicSeries.find(row => row.slug === 'ai').points.find(row => row.bucket === '2026-11-07').count, 0);
});
