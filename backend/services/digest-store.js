import crypto from 'node:crypto';
import { all, get, run, transaction } from '../database/datenbank.js';
import { clusterDigestArticles, mapArticleRow } from '../routes/digest.js';
import { DIGEST_ALGORITHM_VERSION } from './article-ingest.js';
import { loadTopicsByArticleIds } from './article-queries.js';
import { getDigestPeriodDefinition, getDigestTimezone, isPeriodInsideRebuildWindow } from './digest-periods.js';
import { getRebuildWindow } from './digest-periods.js';
import { getActiveTopicRulesVersion } from './topics.js';
import { loadActiveClusters } from './digest-reader.js';
import { readMostReadRankings } from './most-read-reader.js';
import { readRankingRefreshStatus } from './ranking-status.js';

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

const buildingPeriodIds = new Set();

export async function recoverInterruptedDigestGenerations() {
    return transaction(async () => {
        await run(
            `UPDATE digest_generations SET status = 'failed', failedAt = datetime('now'),
             error = COALESCE(error, 'Interrupted before completion') WHERE status = 'building'`,
        );
        return run(
            `UPDATE digest_periods SET status = CASE WHEN activeGenerationId IS NULL THEN 'open' ELSE 'ready' END,
             dirtyAt = COALESCE(dirtyAt, datetime('now')), updatedAt = datetime('now') WHERE status = 'building'`,
        );
    });
}

async function ensurePeriodDefinition(definition, { dirty = false } = {}) {
    const rulesVersion = await getActiveTopicRulesVersion();
    await run(
        `INSERT INTO digest_periods
         (type, periodKey, startsAt, endsAt, timezone, status, dirtyAt, algorithmVersion, rulesVersion, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'open', CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(type, startsAt) DO UPDATE SET updatedAt = datetime('now')`,
        [definition.type, definition.periodKey, definition.startsAt, definition.endsAt, definition.timezone, dirty ? 1 : 0, DIGEST_ALGORITHM_VERSION, rulesVersion],
    );
    return get('SELECT * FROM digest_periods WHERE type = ? AND startsAt = ?', [definition.type, definition.startsAt]);
}

export async function ensureCurrentDigestPeriods(referenceDate = new Date()) {
    const periods = [];
    for (const type of ['day', 'week', 'month']) {
        periods.push(await ensurePeriodDefinition(getDigestPeriodDefinition(type, referenceDate, getDigestTimezone()), { dirty: true }));
    }
    return periods;
}

export async function ensureRebuildWindowDigestPeriods(referenceDate = new Date()) {
    const timezone = getDigestTimezone();
    const currentDay = getDigestPeriodDefinition('day', referenceDate, timezone);
    const currentWeek = getDigestPeriodDefinition('week', referenceDate, timezone);
    const currentMonth = getDigestPeriodDefinition('month', referenceDate, timezone);
    const definitions = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
        definitions.push(getDigestPeriodDefinition('day', new Date(new Date(currentDay.startsAt).getTime() - offset * 86_400_000), timezone));
    }
    definitions.push(getDigestPeriodDefinition('week', new Date(new Date(currentWeek.startsAt).getTime() - 86_400_000), timezone));
    definitions.push(currentWeek);
    definitions.push(getDigestPeriodDefinition('month', new Date(new Date(currentMonth.startsAt).getTime() - 86_400_000), timezone));
    definitions.push(currentMonth);
    const unique = new Map(definitions.map(definition => [`${definition.type}:${definition.startsAt}`, definition]));
    await closeExpiredDigestPeriods(referenceDate);
    const periods = [];
    for (const definition of unique.values()) periods.push(await ensurePeriodDefinition(definition, { dirty: true }));
    return periods;
}

export async function closeExpiredDigestPeriods(referenceDate = new Date()) {
    const window = getRebuildWindow(referenceDate, getDigestTimezone());
    return run(
        `UPDATE digest_periods SET status = 'closed', dirtyAt = NULL, updatedAt = datetime('now')
         WHERE status <> 'closed' AND endsAt <= ? AND (
           (type = 'day' AND startsAt < ?) OR
           (type = 'week' AND startsAt < ?) OR
           (type = 'month' AND startsAt < ?)
         )`,
        [new Date(referenceDate).toISOString(), window.dayStartsAt, window.weekStartsAt, window.monthStartsAt],
    );
}

async function loadGenerationInput(periodId) {
    const rows = await all(
        `SELECT articles.id, articles.feedId, articles.title, articles.teaser, articles.content, articles.url,
                articles.publishedAt, articles.digestFingerprintJson, articles.externalId AS guidOrHash,
                COALESCE(NULLIF(feeds.name, ''), sources.name) AS sourceName
         FROM digest_period_articles
         JOIN articles ON articles.id = digest_period_articles.articleId
         JOIN feeds ON feeds.id = articles.feedId
         JOIN sources ON sources.id = feeds.sourceId
         WHERE digest_period_articles.digestPeriodId = ?
           AND NOT EXISTS (SELECT 1 FROM digest_excluded_feeds WHERE digest_excluded_feeds.feedId = articles.feedId)
           AND NOT EXISTS (SELECT 1 FROM article_bullshit_matches WHERE article_bullshit_matches.articleId = articles.id)
         ORDER BY articles.publishedAt DESC, articles.id DESC`,
        [periodId],
    );
    const mapped = rows.map(mapArticleRow);
    const topicsByArticleId = await loadTopicsByArticleIds(mapped.map(article => article.id), { all });
    return mapped.map(article => ({ ...article, topics: topicsByArticleId.get(Number(article.id)) || [] }));
}

function clusterKeyFor(cluster) {
    const ids = (cluster.items || []).map(item => Number(item.id)).filter(Number.isInteger).sort((a, b) => a - b);
    return `cluster-${ids[0] || hash(cluster.clusterTitle).slice(0, 16)}`;
}

async function beginGeneration(period) {
    return transaction(async () => {
        const next = await get(
            'SELECT COALESCE(MAX(generationNumber), 0) + 1 AS number FROM digest_generations WHERE digestPeriodId = ?',
            [period.id],
        );
        const result = await run(
            `INSERT INTO digest_generations
             (digestPeriodId, generationNumber, status, algorithmVersion, rulesVersion, startedAt)
             VALUES (?, ?, 'building', ?, ?, datetime('now'))`,
            [period.id, Number(next.number), DIGEST_ALGORITHM_VERSION, period.rulesVersion],
        );
        await run("UPDATE digest_periods SET status = 'building', updatedAt = datetime('now') WHERE id = ?", [period.id]);
        return Number(result.lastID);
    });
}

async function publishGeneration(period, generationId, articles, clusters) {
    await transaction(async () => {
        for (let clusterPosition = 0; clusterPosition < clusters.length; clusterPosition += 1) {
            const cluster = clusters[clusterPosition];
            const items = cluster.items || [];
            const clusterKey = clusterKeyFor(cluster);
            const dates = items.map(item => item.publishedAt).filter(Boolean).sort();
            const fingerprint = hash(items.map(item => `${item.id}:${item.publishedAt}:${item.title}`).sort().join('|'));
            const result = await run(
                `INSERT INTO digest_clusters
                 (digestGenerationId, clusterKey, title, representativeArticleId, articleCount,
                  firstPublishedAt, lastPublishedAt, fingerprint, displayPosition)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [generationId, clusterKey, cluster.clusterTitle || 'Untitled', cluster.representative.id, items.length,
                    dates[0] || cluster.representative.publishedAt, dates.at(-1) || cluster.representative.publishedAt,
                    fingerprint, clusterPosition],
            );
            for (let itemPosition = 0; itemPosition < items.length; itemPosition += 1) {
                await run(
                    `INSERT INTO digest_cluster_articles
                     (digestClusterId, digestGenerationId, articleId, position, similarity, isRepresentative)
                     VALUES (?, ?, ?, ?, NULL, ?)`,
                    [result.lastID, generationId, items[itemPosition].id, itemPosition,
                        Number(items[itemPosition].id) === Number(cluster.representative.id) ? 1 : 0],
                );
            }
        }
        await run(
            `UPDATE digest_generations SET status = 'superseded'
             WHERE digestPeriodId = ? AND status = 'ready' AND id <> ?`,
            [period.id, generationId],
        );
        await run(
            `DELETE FROM digest_generations
             WHERE digestPeriodId = ? AND status = 'superseded' AND id NOT IN (
               SELECT id FROM digest_generations WHERE digestPeriodId = ? AND status = 'superseded'
               ORDER BY generationNumber DESC LIMIT 1
             )`,
            [period.id, period.id],
        );
        await run(
            `UPDATE digest_generations SET status = 'ready', sourceArticleCount = ?, clusterCount = ?, generatedAt = datetime('now')
             WHERE id = ?`,
            [articles.length, clusters.length, generationId],
        );
        const shouldClose = new Date(period.endsAt) <= new Date() && !isPeriodInsideRebuildWindow(period);
        await run(
            `UPDATE digest_periods SET activeGenerationId = ?, status = ?, dirtyAt = NULL, generatedAt = datetime('now'),
             algorithmVersion = ?, updatedAt = datetime('now') WHERE id = ?`,
            [generationId, shouldClose ? 'closed' : 'ready', DIGEST_ALGORITHM_VERSION, period.id],
        );
    });
}

export async function generateDigestPeriod(periodId) {
    const normalizedPeriodId = Number(periodId);
    if (buildingPeriodIds.has(normalizedPeriodId)) return { skipped: true, periodId: normalizedPeriodId, reason: 'already-building' };
    buildingPeriodIds.add(normalizedPeriodId);
    try {
        const period = await get(
            'SELECT * FROM digest_periods WHERE id IN (SELECT value FROM json_each(?))',
            [JSON.stringify([normalizedPeriodId])],
        );
        if (!period) throw new Error(`Digest period ${normalizedPeriodId} not found`);
        if (period.status === 'closed' && !isPeriodInsideRebuildWindow(period)) return { skipped: true, periodId: normalizedPeriodId };
        const generationId = await beginGeneration(period);
        try {
            const articles = await loadGenerationInput(period.id);
            let clusters = clusterDigestArticles(articles);
            if (period.type === 'month') clusters = clusters.filter(cluster => (cluster.items || []).length > 1);
            await publishGeneration(period, generationId, articles, clusters);
            return { periodId: Number(period.id), generationId, articleCount: articles.length, clusterCount: clusters.length };
        } catch (error) {
            await transaction(async () => {
                await run(
                    "UPDATE digest_generations SET status = 'failed', failedAt = datetime('now'), error = ? WHERE id = ?",
                    [String(error.message || error).slice(0, 2_000), generationId],
                );
                await run(
                    `UPDATE digest_periods SET status = CASE WHEN activeGenerationId IS NULL THEN 'open' ELSE 'ready' END,
                     dirtyAt = COALESCE(dirtyAt, datetime('now')), updatedAt = datetime('now') WHERE id = ?`,
                    [period.id],
                );
            });
            throw error;
        }
    } finally {
        buildingPeriodIds.delete(normalizedPeriodId);
    }
}

export async function generateDirtyDigestPeriods({ limit = 12 } = {}) {
    const periods = await all(
        `SELECT * FROM digest_periods WHERE dirtyAt IS NOT NULL AND status <> 'closed'
         ORDER BY startsAt DESC, CASE type WHEN 'day' THEN 1 WHEN 'week' THEN 2 ELSE 3 END LIMIT ?`,
        [limit],
    );
    const results = [];
    for (const period of periods) results.push(await generateDigestPeriod(period.id));
    return results;
}

export async function getStoredDigestPayload(type = 'day', referenceDate = new Date()) {
    const definition = getDigestPeriodDefinition(type, referenceDate, getDigestTimezone());
    const period = await ensurePeriodDefinition(definition);
    const clusters = await loadActiveClusters(period, { all });
    const totalArticles = clusters.reduce((sum, cluster) => sum + cluster.items.length, 0);
    return {
        variant: definition.type,
        periodKey: definition.periodKey,
        startIso: definition.startsAt,
        endIso: definition.endsAt,
        status: period.status,
        stale: Boolean(period.dirtyAt),
        generatedAt: period.generatedAt,
        algorithmVersion: period.algorithmVersion,
        rulesVersion: period.rulesVersion,
        totalArticles,
        totalClusters: clusters.length,
        clusters,
        rankings: await readMostReadRankings({ all }),
        rankingStatus: await readRankingRefreshStatus({ all }),
    };
}

export async function readStoredDigestPayload(type = 'day', { all: readAll, get: readGet }, referenceDate = new Date()) {
    const definition = getDigestPeriodDefinition(type, referenceDate, getDigestTimezone());
    const period = await readGet('SELECT * FROM digest_periods WHERE type = ? AND startsAt = ?', [definition.type, definition.startsAt]);
    const clusters = period ? await loadActiveClusters(period, { all: readAll }) : [];
    return {
        variant: definition.type,
        periodKey: definition.periodKey,
        startIso: definition.startsAt,
        endIso: definition.endsAt,
        status: period?.status || 'missing',
        stale: Boolean(period?.dirtyAt),
        generatedAt: period?.generatedAt || null,
        algorithmVersion: period?.algorithmVersion || DIGEST_ALGORITHM_VERSION,
        rulesVersion: period?.rulesVersion || null,
        totalArticles: clusters.reduce((sum, cluster) => sum + cluster.items.length, 0),
        totalClusters: clusters.length,
        clusters,
        rankings: await readMostReadRankings({ all: readAll }),
        rankingStatus: await readRankingRefreshStatus({ all: readAll }),
    };
}

export async function setDigestClustersCompleted(articleIds, completed, type = 'day', referenceDate = new Date()) {
    const ids = [...new Set((articleIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) return { updated: 0, total: 0 };
    const definition = getDigestPeriodDefinition(type, referenceDate, getDigestTimezone());
    const period = await get('SELECT * FROM digest_periods WHERE type = ? AND startsAt = ?', [definition.type, definition.startsAt]);
    if (!period?.activeGenerationId) return { updated: 0, total: ids.length };
    const rows = await all(
        `SELECT DISTINCT digest_clusters.clusterKey FROM digest_cluster_articles
         JOIN digest_clusters ON digest_clusters.id = digest_cluster_articles.digestClusterId
         WHERE digest_clusters.digestGenerationId = ?
           AND digest_cluster_articles.articleId IN (SELECT value FROM json_each(?))`,
        [period.activeGenerationId, JSON.stringify(ids)],
    );
    await transaction(async () => {
        for (const row of rows) {
            await run(
                `INSERT INTO digest_cluster_state
                 (digestPeriodId, clusterKey, completedAt, createdAt, updatedAt)
                 VALUES (?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, datetime('now'), datetime('now'))
                 ON CONFLICT(digestPeriodId, clusterKey) DO UPDATE SET
                   completedAt = excluded.completedAt, updatedAt = datetime('now')`,
                [period.id, row.clusterKey, completed ? 1 : 0],
            );
        }
    });
    return { updated: rows.length, total: rows.length, periodKey: period.periodKey };
}

export async function markAllDigestPeriodsDirty() {
    return run("UPDATE digest_periods SET dirtyAt = datetime('now'), updatedAt = datetime('now') WHERE status <> 'closed'");
}
