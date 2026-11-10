import express from 'express';
import { all, get, transaction } from '../database/datenbank.js';
import { auth } from '../middleware/auth.js';
import { requestSchema } from '../middleware/validate-request.js';
import { ANALYTICS_PERIODS, ANALYTICS_RANKING_KEYS, ANALYTICS_SORTS, normalizeAnalyticsFilters } from '../services/analytics-filters.js';
import { readAnalyticsOverview, readAnalyticsTrends, readAnalyticsPublishers, readAnalyticsTopics, readAnalyticsLibrary } from '../services/analytics-reader.js';
import { readAnalyticsMostRead, readAnalyticsRankingHistory } from '../services/analytics-rankings.js';

const identifier = { type: 'string', pattern: '^[1-9][0-9]{0,14}$' };
const topic = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' };
const query = {
    type: 'object', additionalProperties: false, properties: {
        period: { type: 'string', enum: ANALYTICS_PERIODS },
        publisher: { anyOf: [identifier, { const: 'all' }, { const: '' }] },
        topic: { anyOf: [topic, { const: '' }] },
        group: { type: 'string', enum: ['day', 'week', 'month'] },
        basis: { type: 'string', enum: ['publishedAt', 'fetchedAt'] },
        rankingKey: { type: 'string', enum: ['all', ...ANALYTICS_RANKING_KEYS] },
        topics: { type: 'string', maxLength: 1024 },
        compare: { type: 'string', maxLength: 32 },
        sort: { type: 'string', enum: ANALYTICS_SORTS },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
        offset: { type: 'string', pattern: '^(0|[1-9][0-9]{0,6})$' },
    },
};
const historyQuery = { ...query, required: ['sourceId', 'url'], properties: {
    ...query.properties, sourceId: identifier, url: { type: 'string', minLength: 1, maxLength: 4096 },
    historyLimit: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' },
} };

export function createAnalyticsRouter({
    database = { all, get },
    withSnapshot = callback => transaction(callback, { mode: 'DEFERRED' }),
    now = () => new Date(),
    readers = {},
} = {}) {
    const router = express.Router();
    const services = {
        overview: readAnalyticsOverview, trends: readAnalyticsTrends, publishers: readAnalyticsPublishers,
        'most-read': readAnalyticsMostRead, topics: readAnalyticsTopics, library: readAnalyticsLibrary,
        history: readAnalyticsRankingHistory, ...readers,
    };
    router.use(auth);
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/filters', requestSchema.validate({ query: { type: 'object', additionalProperties: false } }), async (_req, res) => {
        const result = await withSnapshot(async () => ({
            publishers: await database.all('SELECT id, name FROM sources ORDER BY name COLLATE NOCASE, id'),
            topics: await database.all('SELECT id, slug, label FROM topics ORDER BY label COLLATE NOCASE, id'),
            asOf: now().toISOString(),
        }));
        res.json(result);
    });
    const respond = reader => async (req, res) => {
        try {
            const filters = normalizeAnalyticsFilters(req.query, { now: now() });
            res.json(await withSnapshot(() => reader(database, filters)));
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ error: error.message });
            throw error;
        }
    };
    router.get('/most-read/history', requestSchema.validate({ query: historyQuery }), respond(services.history));
    for (const section of ['overview', 'trends', 'publishers', 'most-read', 'topics', 'library']) {
        router.get(`/${section}`, requestSchema.validate({ query }), respond(services[section]));
    }
    return router;
}

export default createAnalyticsRouter();
