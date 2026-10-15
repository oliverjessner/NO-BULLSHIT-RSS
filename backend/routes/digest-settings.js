import express from 'express';
import { all, get, run } from '../database/datenbank.js';
import { auth } from '../middleware/auth.js';
import { positiveIdParamsSchema, requestSchema as schema } from '../middleware/validate-request.js';
import { publish } from '../services/events.js';
import { generateDirtyDigestPeriods, markAllDigestPeriodsDirty } from '../services/digest-store.js';
import { logWarn } from '../utils/logger.js';

const router = express.Router();

async function rebuildDirtyDigests() {
    await generateDirtyDigestPeriods().catch(error => logWarn('Digest rebuild after settings change failed', { error: error.message }));
}

function normalizeFeedIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const ids = new Set();
    value.forEach(id => {
        const normalized = Number(id);
        if (Number.isInteger(normalized) && normalized > 0) {
            ids.add(normalized);
        }
    });

    return Array.from(ids);
}

async function getDigestSettingsPayload() {
    const excludedFeedRows = await all('SELECT feedId FROM digest_excluded_feeds ORDER BY feedId ASC');

    return {
        excludedFeedIds: excludedFeedRows
            .map(row => Number(row.feedId))
            .filter(feedId => Number.isInteger(feedId) && feedId > 0),
    };
}

router.get('/', auth, async (_req, res) => {
    return res.json(await getDigestSettingsPayload());
});

router.put('/excluded-feeds', auth, async ({ body }, res) => {
    const incomingFeedIds = normalizeFeedIds(body?.feedIds);

    let validFeedIds = [];
    if (incomingFeedIds.length > 0) {
        const rows = await all('SELECT id FROM feeds WHERE id IN (SELECT value FROM json_each(?))', [
            JSON.stringify(incomingFeedIds),
        ]);
        const validIdSet = new Set(
            rows.map(row => Number(row.id)).filter(feedId => Number.isInteger(feedId) && feedId > 0),
        );
        validFeedIds = incomingFeedIds.filter(feedId => validIdSet.has(feedId));
    }

    await run('BEGIN IMMEDIATE');
    try {
        await run('DELETE FROM digest_excluded_feeds');
        for (const feedId of validFeedIds) {
            await run(
                `INSERT OR IGNORE INTO digest_excluded_feeds (feedId, createdAt)
                 VALUES (?, datetime('now'))`,
                [feedId],
            );
        }
        await run('COMMIT');
    } catch (err) {
        try {
            await run('ROLLBACK');
        } catch {
            // ignore rollback error to preserve original failure
        }
        throw err;
    }

    await markAllDigestPeriodsDirty();
    await rebuildDirtyDigests();

    publish('digest.settings.updated', { type: 'excluded-feeds', total: validFeedIds.length });

    return res.json(await getDigestSettingsPayload());
});

router.patch('/excluded-feeds/:id', auth, schema.validate({
    params: positiveIdParamsSchema,
    body: {
        type: 'object', required: ['excluded'],
        properties: { excluded: { type: 'boolean' } }, additionalProperties: false,
    },
}), async ({ params, body }, res) => {
    const feedId = Number(params.id);
    if (!await get('SELECT id FROM feeds WHERE id = ?', [feedId])) {
        return res.status(404).json({ error: 'Feed not found' });
    }
    if (body.excluded) {
        await run("INSERT OR IGNORE INTO digest_excluded_feeds (feedId, createdAt) VALUES (?, datetime('now'))", [feedId]);
    } else {
        await run('DELETE FROM digest_excluded_feeds WHERE feedId = ?', [feedId]);
    }
    await markAllDigestPeriodsDirty();
    await rebuildDirtyDigests();
    publish('digest.settings.updated', { type: 'excluded-feeds', feedId, excluded: body.excluded });
    return res.json(await getDigestSettingsPayload());
});

export default router;
