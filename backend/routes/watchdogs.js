import express from 'express';
import { auth } from '../middleware/auth.js';
import { positiveIdParamsSchema, requestSchema as schema } from '../middleware/validate-request.js';
import * as watchdogs from '../services/watchdogs.js';
import { all } from '../database/datenbank.js';
import { queryArticles } from '../services/article-queries.js';
import { WATCHDOG_RANGES } from '../services/watchdog-filters.js';

const router = express.Router();
const terms = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } };
const properties = {
    name: { type: 'string', minLength: 1, maxLength: 200 }, enabled: { type: 'boolean' },
    includeAny: terms, includeAll: terms, exclude: terms,
    feedIds: { type: 'array', maxItems: 500, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
};
const id = schema.validate({ params: positiveIdParamsSchema });
const create = { type: 'object', required: ['name'], properties: { ...properties, includeHistory: { type: 'boolean' } }, additionalProperties: false };
const update = { type: 'object', minProperties: 1, properties, additionalProperties: false };
const state = { type: 'object', minProperties: 1, properties: { read: { type: 'boolean' }, archived: { type: 'boolean' } }, additionalProperties: false };
const matchFilters = {
    status: { type: 'string', enum: ['all', 'unread', 'read'] }, watchdogId: { type: 'string', pattern: '^[1-9]\\d*$' },
    archived: { type: 'string', enum: ['true', 'false'] }, range: { type: 'string', enum: WATCHDOG_RANGES },
    asOf: { type: 'string', pattern: '^\\d{13}$' },
};

router.use(auth);
router.get('/', async (_req, res) => {
    const rules = await watchdogs.listWatchdogs();
    res.json({ watchdogs: rules, unreadCount: rules.reduce((sum, rule) => sum + rule.unreadCount, 0) });
});
router.get('/notifications', async (_req, res) => res.json(await watchdogs.notificationSettings()));
router.patch('/notifications', schema.validate({ body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } }, additionalProperties: false } }),
    async ({ body }, res) => res.json(await watchdogs.setNotificationSettings(body.enabled)));
router.get('/export', schema.validate({ query: { type: 'object', properties: {
    ...matchFilters, limit: { type: 'string', pattern: '^(?:[1-9]\\d?|1\\d\\d|2[0-4]\\d|250)$' },
    cursorPublishedAt: { type: 'string', minLength: 1, maxLength: 40 }, cursorId: { type: 'string', pattern: '^[1-9]\\d*$' },
}, additionalProperties: false } }), async ({ query }, res) => {
    const { limit = 250, cursorPublishedAt, cursorId, ...filters } = query;
    res.json(await queryArticles({ limit, cursorPublishedAt, cursorId, activeOnly: false,
        watchdog: { ...filters, archived: query.archived === 'true' } }, { all }));
});
router.get('/matches', schema.validate({ query: { type: 'object', properties: {
    ...matchFilters, before: { type: 'string', pattern: '^[1-9]\\d*$' },
}, additionalProperties: false } }), async ({ query }, res) => res.json(await watchdogs.listMatches({ ...query, archived: query.archived === 'true' })));
router.get('/matches/:id', id, async ({ params }, res) => {
    const match = await watchdogs.getMatch(params.id);
    return match ? res.json(match) : res.status(404).json({ error: 'Match not found' });
});
router.patch('/matches/:id', id, schema.validate({ body: state }), async ({ params, body }, res) => {
    const match = await watchdogs.updateMatch(params.id, body);
    return match ? res.json(match) : res.status(404).json({ error: 'Match not found' });
});
router.post('/', schema.validate({ body: create }), async ({ body }, res) => {
    try { res.status(201).json(await watchdogs.createWatchdog(body)); } catch (error) { res.status(400).json({ error: error.message }); }
});
router.patch('/:id', id, schema.validate({ body: update }), async ({ params, body }, res) => {
    try {
        const watchdog = await watchdogs.updateWatchdog(params.id, body);
        return watchdog ? res.json({ watchdog }) : res.status(404).json({ error: 'Watchdog not found' });
    } catch (error) { return res.status(400).json({ error: error.message }); }
});
router.delete('/:id', id, async ({ params }, res) => {
    return await watchdogs.deleteWatchdog(params.id) ? res.status(204).end() : res.status(404).json({ error: 'Watchdog not found' });
});
export default router;
