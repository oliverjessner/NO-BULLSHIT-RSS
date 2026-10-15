import express from 'express';
import { positiveIdParamsSchema, requestSchema as schema } from '../middleware/validate-request.js';
import { auth } from '../middleware/auth.js';
import { publish } from '../services/events.js';
import {
    createBullshitRule,
    deleteBullshitRule,
    getBullshitRules,
    reevaluateAllArticles,
    updateBullshitRule,
} from '../services/bullshit-rules.js';
import { generateDirtyDigestPeriods, markAllDigestPeriodsDirty } from '../services/digest-store.js';

const router = express.Router();

const ruleProperties = {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    enabled: { type: 'boolean' },
    field: { type: 'string', enum: ['title', 'teaser', 'url', 'source'] },
    operator: { type: 'string', enum: ['contains', 'not_contains', 'equals', 'regex'] },
    value: { type: 'string', minLength: 1, maxLength: 500 },
};
const createRuleSchema = {
    type: 'object',
    required: ['name', 'field', 'operator', 'value'],
    properties: ruleProperties,
    additionalProperties: false,
};
const updateRuleSchema = {
    type: 'object',
    minProperties: 1,
    properties: ruleProperties,
    additionalProperties: false,
};

async function reEvaluateAndPublish(action, rule = null) {
    const reEvaluation = await reevaluateAllArticles();
    await markAllDigestPeriodsDirty();
    await generateDirtyDigestPeriods();
    publish('bullshit-rules.updated', { action, ruleId: rule?.id || null, ...reEvaluation });
    publish('articles.updated', { source: 'bullshit-rules', ...reEvaluation });
    return reEvaluation;
}

router.get('/', auth, async (_req, res) => res.json(await getBullshitRules()));

router.post('/', auth, schema.validate({ body: createRuleSchema }), async ({ body }, res) => {
    try {
        const rule = await createBullshitRule(body);
        const reEvaluation = await reEvaluateAndPublish('created', rule);
        return res.status(201).json({ rule, reEvaluation });
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Could not create bullshit rule' });
    }
});

router.patch('/:id', auth, schema.validate({ params: positiveIdParamsSchema, body: updateRuleSchema }), async ({ params, body }, res) => {
    try {
        const rule = await updateBullshitRule(params.id, body);
        if (!rule) return res.status(404).json({ error: 'Bullshit rule not found' });
        const reEvaluation = await reEvaluateAndPublish('updated', rule);
        return res.json({ rule, reEvaluation });
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Could not update bullshit rule' });
    }
});

router.delete('/:id', auth, schema.validate({ params: positiveIdParamsSchema }), async ({ params }, res) => {
    const removed = await deleteBullshitRule(params.id);
    if (!removed) return res.status(404).json({ error: 'Bullshit rule not found' });
    const reEvaluation = await reEvaluateAndPublish('deleted', { id: Number(params.id) });
    return res.json({ ok: true, reEvaluation });
});

router.post('/re-evaluate', auth, async (_req, res) => {
    try {
        const reEvaluation = await reEvaluateAndPublish('re-evaluated');
        return res.json({ ok: true, reEvaluation });
    } catch (error) {
        return res.status(500).json({ error: error.message || 'Bullshit rule re-evaluation failed' });
    }
});

export default router;

