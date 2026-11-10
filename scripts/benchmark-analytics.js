import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { analyticsFixture, seedAnalyticsBenchmark } from '../backend/services/analytics-fixture.js';
import { normalizeAnalyticsFilters } from '../backend/services/analytics-filters.js';
import { readAnalyticsOverview, readAnalyticsTrends, readAnalyticsPublishers, readAnalyticsTopics, readAnalyticsLibrary } from '../backend/services/analytics-reader.js';
import { readAnalyticsMostRead, readAnalyticsRankingHistory } from '../backend/services/analytics-rankings.js';

const articles = Number(process.argv[2] || 100_000);
const rankingRecords = Number(process.argv[3] || 300_000);
const database = await analyticsFixture();
try {
    await seedAnalyticsBenchmark(database, { articles, rankings: rankingRecords });
    const filters = normalizeAnalyticsFilters({ compare: '1,3' }, { now: new Date('2026-11-10T12:00:00.000Z') });
    console.log(`Synthetic, in-memory library: ${articles} articles; ${rankingRecords} ranking records. Production data is not opened.`);
    for (const [section, reader] of Object.entries({ overview: readAnalyticsOverview, trends: readAnalyticsTrends, publishers: readAnalyticsPublishers, topics: readAnalyticsTopics, library: readAnalyticsLibrary, 'most-read': readAnalyticsMostRead })) {
        const started = performance.now();
        const result = await reader(database, filters);
        if (section === 'overview' || section === 'library') assert.equal(result.kpis.totalArticles, articles);
        console.log(JSON.stringify({ section, milliseconds: Math.round(performance.now() - started), payloadBytes: Buffer.byteLength(JSON.stringify(result)) }));
    }
    const started = performance.now();
    const history = await readAnalyticsRankingHistory(database, { ...filters, sourceId: 1, url: 'https://benchmark.test/article/0' });
    console.log(JSON.stringify({ section: 'ranking-history', milliseconds: Math.round(performance.now() - started), observations: history.pagination.total, returned: history.series.reduce((sum, series) => sum + series.points.length, 0), hasMore: history.pagination.hasMore }));
} finally { await database.close(); }
