import express from 'express';
import { all } from '../database/datenbank.js';
import { auth } from '../middleware/auth.js';
import { requestSchema as schema } from '../middleware/validate-request.js';
import { readPublisherRankingsPayload } from '../services/publisher-rankings-reader.js';
import { isRankingRefreshRunning, refreshMostReadRankings, waitForRankingRefresh } from '../services/most-read.js';
import {
    getGolemAccessStatus, startGolemAccess, confirmGolemAccess, cancelGolemAccess, forgetGolemAccess,
} from '../services/golem-access.js';

const mediumProperty = { type: 'string', enum: ['golem'] };
const mediumQuery = { type: 'object', properties: { medium: mediumProperty }, additionalProperties: false };
const mediumBody = { ...mediumQuery, required: ['medium'] };
const jobBody = {
    type: 'object', required: ['medium', 'jobId'], additionalProperties: false,
    properties: { medium: mediumProperty, jobId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
};

export function createRankingsRouter({
    readPayload = medium => readPublisherRankingsPayload(medium, { all }),
    refresh = refreshMostReadRankings,
    isRefreshing = isRankingRefreshRunning,
    waitForRefresh = waitForRankingRefresh,
    access = {
        status: getGolemAccessStatus, start: startGolemAccess, confirm: confirmGolemAccess,
        cancel: cancelGolemAccess, forget: forgetGolemAccess,
    },
} = {}) {
    const router = express.Router();
    const payload = async medium => ({ ...await readPayload(medium), access: await access.status() });
    const sendRefreshResult = async (res, medium) => {
        const result = await payload(medium);
        if (result.rankingStatus.state === 'error') return res.status(502).json({ ...result, error: result.rankingStatus.message });
        return res.json(result);
    };
    const accessFailure = async (res, medium, error) => {
        const conflicts = new Set(['ACCESS_BUSY', 'ACCESS_STALE', 'ACCESS_NOT_READY', 'ACCESS_CANCELLED']);
        const message = error.code === 'ACCESS_BUSY' ? 'Golem access setup is already running.'
            : error.code === 'ACCESS_STALE' ? 'This Golem access setup is no longer active.'
            : error.code === 'ACCESS_NOT_READY' ? 'Wait for the Golem browser to open before saving access.'
            : error.code === 'ACCESS_CANCELLED' ? 'Golem access setup was cancelled.'
            : 'Golem access could not be saved. Set up access again.';
        return res.status(conflicts.has(error.code) ? 409 : 502).json({ ...await payload(medium), error: message });
    };

    router.get('/', auth, schema.validate({ query: mediumQuery }), async (req, res) => res.json(await payload(req.query.medium || 'golem')));
    router.post('/refresh', auth, schema.validate({ body: mediumBody }), async (req, res) => {
        const { medium } = req.body;
        if (isRefreshing()) return res.status(409).json({ ...await payload(medium), error: 'Publisher rankings are already refreshing.' });
        await refresh();
        return sendRefreshResult(res, medium);
    });
    router.post('/access/start', auth, schema.validate({ body: mediumBody }), async (req, res) => {
        try {
            await access.start();
            return res.status(202).json(await payload(req.body.medium));
        } catch (error) { return accessFailure(res, req.body.medium, error); }
    });
    router.post('/access/confirm', auth, schema.validate({ body: jobBody }), async (req, res) => {
        try {
            await access.confirm(req.body.jobId);
        } catch (error) { return accessFailure(res, req.body.medium, error); }
        // A scheduled capture may have started with the previous session. Finish
        // that attempt before verifying the newly saved access explicitly.
        await waitForRefresh();
        await refresh();
        return sendRefreshResult(res, req.body.medium);
    });
    router.post('/access/cancel', auth, schema.validate({ body: jobBody }), async (req, res) => {
        try {
            await access.cancel(req.body.jobId);
            return res.json(await payload(req.body.medium));
        } catch (error) { return accessFailure(res, req.body.medium, error); }
    });
    router.delete('/access', auth, schema.validate({ query: mediumQuery }), async (req, res) => {
        try {
            await access.forget();
            return res.json(await payload(req.query.medium || 'golem'));
        } catch (error) { return accessFailure(res, req.query.medium || 'golem', error); }
    });
    return router;
}

export default createRankingsRouter();
