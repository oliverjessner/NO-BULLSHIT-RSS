import express from 'express';
import { all } from '../database/datenbank.js';
import { auth } from '../middleware/auth.js';
import { requestSchema as schema } from '../middleware/validate-request.js';
import { readPublisherRankingsPayload, RANKING_MEDIA } from '../services/publisher-rankings-reader.js';
import { isRankingRefreshRunning, refreshMostReadRankings } from '../services/most-read.js';
import { readTopArticles } from '../services/top-articles-reader.js';

const mediumProperty = { type: 'string', enum: ['all', ...RANKING_MEDIA.map(medium => medium.id)] };
const mediumQuery = { type: 'object', properties: { medium: mediumProperty }, additionalProperties: false };
const mediumBody = { ...mediumQuery, required: ['medium'] };
const topQuery = { type: 'object', additionalProperties: false, properties: {
    medium: mediumProperty,
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
} };

export function createRankingsRouter({
    readPayload = medium => readPublisherRankingsPayload(medium, { all }),
    readTop = options => readTopArticles({ all }, options),
    refresh = refreshMostReadRankings,
    isRefreshing = isRankingRefreshRunning,
} = {}) {
    const router = express.Router();
    const payload = medium => medium === 'all' ? readTop({ medium: 'all' }) : readPayload(medium);
    const sendRefreshResult = async (res, medium) => {
        const result = await payload(medium);
        if (result.rankingStatus.state === 'error') return res.status(502).json({ ...result, error: result.rankingStatus.message });
        return res.json(result);
    };

    router.get('/', auth, schema.validate({ query: mediumQuery }), async (req, res) => res.json(await payload(req.query.medium || 'golem')));
    router.get('/top', auth, schema.validate({ query: topQuery }), async (req, res) => {
        try {
            return res.json(await readTop({ medium: req.query.medium || 'all', limit: Number(req.query.limit || 40), cursor: req.query.cursor || null }));
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ error: error.message });
            throw error;
        }
    });
    router.post('/refresh', auth, schema.validate({ body: mediumBody }), async (req, res) => {
        const { medium } = req.body;
        if (isRefreshing()) return res.status(409).json({ ...await payload(medium), error: 'Publisher rankings are already refreshing.' });
        await refresh(medium === 'all' ? {} : { medium });
        return sendRefreshResult(res, medium);
    });
    return router;
}

export default createRankingsRouter();
