import crypto from 'node:crypto';
import { cleanHttpUrl } from '../utils/url.js';
import { get, run, transaction } from '../database/datenbank.js';
import { canonicalizeArticleUrl, createDigestFingerprint } from '../routes/digest.js';
import { getDigestPeriodsForArticle, getDigestTimezone, isPeriodInsideRebuildWindow } from './digest-periods.js';
import { classifyAndPersistArticleTopics, getActiveTopicRulesVersion } from './topics.js';
import { evaluateAndPersistArticleBullshit } from './bullshit-rules.js';
import { logWarn } from '../utils/logger.js';

export const DIGEST_ALGORITHM_VERSION = 'digest-v2.1';
export const DIGEST_FINGERPRINT_VERSION = 'fingerprint-v1';

function cleanText(value, maxLength) {
    const text = String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text ? text.slice(0, maxLength) : null;
}

function toIsoDate(value, fallback) {
    const date = value ? new Date(value) : new Date(fallback);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
}

function hashContent(article) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify([article.title, article.teaser, article.content, article.url, article.publishedAt]))
        .digest('hex');
}

function serializeFingerprint(article) {
    const fingerprint = createDigestFingerprint(article);
    return JSON.stringify({
        hash: fingerprint.hash,
        canonicalUrl: fingerprint.canonicalUrl,
        publishedAtMs: fingerprint.publishedAtMs,
        tokens: Array.from(fingerprint.tokenSet),
        titleAnchors: Array.from(fingerprint.titleAnchorSet),
    });
}

export function normalizeIncomingArticle(input, { fetchedAt = new Date().toISOString() } = {}) {
    const normalizedFetchedAt = toIsoDate(input.fetchedAt || fetchedAt, new Date().toISOString());
    const externalId = String(input.externalId || input.guidOrHash || input.guid || input.id || input.url || '').trim();
    if (!externalId) throw new Error('Article requires a feed-scoped external id');
    const article = {
        feedId: Number(input.feedId),
        externalId,
        title: cleanText(input.title, 1_000),
        teaser: cleanText(input.teaser || input.summary || input.description || input.contentSnippet, 2_000),
        content: cleanText(input.content || input.body || input.description || input.summary, 20_000),
        url: cleanHttpUrl(input.url),
        publishedAt: toIsoDate(input.publishedAt || input.isoDate || input.pubDate || input.published, normalizedFetchedAt),
        fetchedAt: normalizedFetchedAt,
    };
    if (!Number.isInteger(article.feedId) || article.feedId <= 0) throw new Error('Article requires a valid feed id');
    article.canonicalUrl = canonicalizeArticleUrl(article.url);
    article.contentHash = hashContent(article);
    article.digestFingerprintJson = serializeFingerprint(article);
    return article;
}

async function ensurePeriod(period, rulesVersion) {
    const rebuildable = isPeriodInsideRebuildWindow(period);
    await run(
        `INSERT INTO digest_periods
         (type, periodKey, startsAt, endsAt, timezone, status, dirtyAt, algorithmVersion, rulesVersion, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(type, startsAt) DO UPDATE SET
           dirtyAt = CASE WHEN digest_periods.status = 'closed' THEN digest_periods.dirtyAt ELSE datetime('now') END,
           algorithmVersion = excluded.algorithmVersion,
           rulesVersion = excluded.rulesVersion, updatedAt = datetime('now')`,
        [period.type, period.periodKey, period.startsAt, period.endsAt, period.timezone, rebuildable ? 'open' : 'closed', rebuildable ? 1 : 0,
            DIGEST_ALGORITHM_VERSION, rulesVersion],
    );
    return get('SELECT id FROM digest_periods WHERE type = ? AND startsAt = ?', [period.type, period.startsAt]);
}

async function assignArticlePeriods(articleId, publishedAt, rulesVersion) {
    const periodIds = [];
    for (const period of getDigestPeriodsForArticle(publishedAt, getDigestTimezone())) {
        const row = await ensurePeriod(period, rulesVersion);
        await run(
            `INSERT INTO digest_period_articles (digestPeriodId, articleId, assignedAt)
             VALUES (?, ?, datetime('now')) ON CONFLICT(digestPeriodId, articleId) DO NOTHING`,
            [row.id, articleId],
        );
        periodIds.push(Number(row.id));
    }
    return periodIds;
}

export async function ingestArticle(input) {
    const article = normalizeIncomingArticle(input);
    const rulesVersion = await getActiveTopicRulesVersion();
    const persisted = await transaction(async () => {
        const existing = await get('SELECT id, contentHash, publishedAt, classificationStatus, classificationVersion FROM articles WHERE feedId = ? AND externalId = ?', [
            article.feedId,
            article.externalId,
        ]);
        if (existing && existing.contentHash === article.contentHash) {
            await run('UPDATE articles SET fetchedAt = ?, updatedAt = ? WHERE id = ?', [article.fetchedAt, article.fetchedAt, existing.id]);
            const needsClassification = existing.classificationStatus !== 'ready' || existing.classificationVersion !== rulesVersion;
            return { id: Number(existing.id), inserted: false, changed: false, needsClassification, affectedPeriodIds: [] };
        }

        let articleId;
        if (existing) {
            articleId = Number(existing.id);
            await run(
                `UPDATE articles SET title = ?, teaser = ?, content = ?, url = ?, canonicalUrl = ?, contentHash = ?,
                 publishedAt = ?, fetchedAt = ?, updatedAt = ?, classificationStatus = 'pending',
                 fingerprintVersion = ?, digestFingerprintJson = ? WHERE id = ?`,
                [article.title, article.teaser, article.content, article.url, article.canonicalUrl, article.contentHash, article.publishedAt,
                    article.fetchedAt, article.fetchedAt, DIGEST_FINGERPRINT_VERSION, article.digestFingerprintJson, articleId],
            );
            await run(
                `UPDATE digest_periods SET dirtyAt = datetime('now'), updatedAt = datetime('now')
                 WHERE id IN (SELECT digestPeriodId FROM digest_period_articles WHERE articleId = ?)`,
                [articleId],
            );
            if (existing.publishedAt !== article.publishedAt) {
                await run('DELETE FROM digest_period_articles WHERE articleId = ?', [articleId]);
            }
        } else {
            const result = await run(
                `INSERT INTO articles
                 (feedId, externalId, title, teaser, content, url, canonicalUrl, contentHash, publishedAt, fetchedAt,
                  createdAt, updatedAt, classificationStatus, fingerprintVersion, digestFingerprintJson)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
                [article.feedId, article.externalId, article.title, article.teaser, article.content, article.url, article.canonicalUrl,
                    article.contentHash, article.publishedAt, article.fetchedAt, article.fetchedAt, article.fetchedAt,
                    DIGEST_FINGERPRINT_VERSION, article.digestFingerprintJson],
            );
            articleId = Number(result.lastID);
            await run(
                `INSERT INTO article_state (articleId, createdAt, updatedAt) VALUES (?, datetime('now'), datetime('now'))`,
                [articleId],
            );
        }
        const affectedPeriodIds = await assignArticlePeriods(articleId, article.publishedAt, rulesVersion);
        return { id: articleId, inserted: !existing, changed: true, affectedPeriodIds };
    });

    let classificationError = null;
    if (persisted.changed || persisted.needsClassification) {
        try {
            await classifyAndPersistArticleTopics({ id: persisted.id, ...article });
        } catch (error) {
            await run("UPDATE articles SET classificationStatus = 'failed', updatedAt = datetime('now') WHERE id = ?", [persisted.id]);
            classificationError = error;
        }
    }
    if (persisted.changed) {
        try {
            await evaluateAndPersistArticleBullshit({ id: persisted.id, ...article });
        } catch (error) {
            logWarn('Bullshit rule evaluation failed during ingest', { articleId: persisted.id, error: error.message });
        }
    }
    if (classificationError) throw classificationError;
    return { ...persisted, article };
}
