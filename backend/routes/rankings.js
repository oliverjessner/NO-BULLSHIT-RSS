import express from 'express';
import { all } from '../database/datenbank.js';
import { auth } from '../middleware/auth.js';
import { requestSchema as schema } from '../middleware/validate-request.js';
import { readPublisherRankingsPayload } from '../services/publisher-rankings-reader.js';
import { isRankingRefreshRunning, refreshMostReadRankings } from '../services/most-read.js';

const mediumProperty = { type: 'string', enum: ['golem'] };
const mediumQuery = { type: 'object', properties: { medium: mediumProperty }, additionalProperties: false };
const mediumBody = { ...mediumQuery, required: ['medium'] };

export function createRankingsRouter({
    readPayload = medium => readPublisherRankingsPayload(medium, { all }),
    refresh = refreshMostReadRankings,
    isRefreshing = isRankingRefreshRunning,
} = {}) {
    const router = express.Router();
    const payload = medium => readPayload(medium);
    const sendRefreshResult = async (res, medium) => {
        const result = await payload(medium);
        if (result.rankingStatus.state === 'error') return res.status(502).json({ ...result, error: result.rankingStatus.message });
        return res.json(result);
    };

    router.get('/', auth, schema.validate({ query: mediumQuery }), async (req, res) => res.json(await payload(req.query.medium || 'golem')));
    router.post('/refresh', auth, schema.validate({ body: mediumBody }), async (req, res) => {
        const { medium } = req.body;
        if (isRefreshing()) return res.status(409).json({ ...await payload(medium), error: 'Publisher rankings are already refreshing.' });
        await refresh();
        return sendRefreshResult(res, medium);
    });
    return router;
}

export default createRankingsRouter();
