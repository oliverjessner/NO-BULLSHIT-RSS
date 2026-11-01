import { all, get, run, transaction } from '../database/datenbank.js';
import { cleanHttpUrl } from '../utils/url.js';
import { logWarn } from '../utils/logger.js';
import { fetchGolemRankings, isGolemSource, RANKING_KEYS } from './golem-rankings.js';
import { loadRankingArticleIndex } from './most-read-reader.js';
import { normalizeRankingStatus, RANKING_STATUS_KEY } from './ranking-status.js';
import { publish } from './events.js';

const database = { all, get };
const host = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function validateRankings(rankings, websiteUrl) {
    if (!rankings || Object.keys(rankings).some(key => !RANKING_KEYS.includes(key))) throw new Error('Invalid ranking keys');
    return RANKING_KEYS.flatMap(rankingKey => {
        const items = rankings[rankingKey];
        if (!Array.isArray(items) || !items.length || items.length > 50) throw new Error('Both complete article rankings are required');
        const urls = new Set();
        const ranks = new Set();
        return items.map(item => {
            const canonicalUrl = cleanHttpUrl(item.canonicalUrl);
            const rank = Number(item.rank);
            if (!canonicalUrl || host(canonicalUrl) !== host(websiteUrl) || !Number.isInteger(rank) || rank <= 0 || ranks.has(rank) || urls.has(canonicalUrl)) {
                throw new Error('Ranking contains an invalid or duplicate article');
            }
            ranks.add(rank); urls.add(canonicalUrl);
            return { rankingKey, canonicalUrl, rank, title: String(item.title || '').trim().slice(0, 1_000) || null };
        });
    });
}

export async function saveMostReadSnapshot({ sourceId, capturedAt, rankings }) {
    const id = Number(sourceId);
    if (!Number.isInteger(id) || id <= 0 || typeof capturedAt !== 'string' || !capturedAt.trim() || !Number.isFinite(new Date(capturedAt).getTime())) throw new Error('Invalid ranking capture');
    const timestamp = new Date(capturedAt).toISOString();
    return transaction(async () => {
        const source = await get('SELECT websiteUrl FROM sources WHERE id = ?', [id]);
        const feeds = await all('SELECT feedUrl FROM feeds WHERE sourceId = ?', [id]);
        if (!source || !cleanHttpUrl(source.websiteUrl) || !feeds.some(feed => cleanHttpUrl(feed.feedUrl))) throw new Error('Ranking source requires an RSS feed');
        const rows = validateRankings(rankings, source.websiteUrl);
        const previous = await all('SELECT rankingKey, canonicalUrl, rank, title FROM most_read WHERE sourceId = ? AND capturedAt = ? ORDER BY rankingKey, rank', [id, timestamp]);
        const sorted = [...rows].sort((a, b) => a.rankingKey.localeCompare(b.rankingKey) || a.rank - b.rank);
        if (previous.length) {
            if (JSON.stringify(previous) !== JSON.stringify(sorted)) throw new Error('Ranking capture already exists with different content');
            return { inserted: 0, capturedAt: timestamp };
        }
        const index = await loadRankingArticleIndex(id, database, rows.map(row => row.canonicalUrl));
        for (const row of rows) {
            const articleId = index.get(row.canonicalUrl)?.[0]?.id || null;
            await run(`INSERT INTO most_read (sourceId, articleId, canonicalUrl, title, rank, rankingKey, capturedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, articleId, row.canonicalUrl, row.title, row.rank, row.rankingKey, timestamp]);
        }
        return { inserted: rows.length, capturedAt: timestamp };
    });
}

export async function reconcileMostReadArticles() {
    return transaction(async () => {
        const sources = await all('SELECT DISTINCT sourceId FROM most_read');
        let updated = 0;
        for (const { sourceId } of sources) {
            const rows = await all(`SELECT id, articleId, canonicalUrl FROM most_read WHERE sourceId = ?
                AND capturedAt = (SELECT MAX(latest.capturedAt) FROM most_read AS latest
                    WHERE latest.sourceId = most_read.sourceId AND latest.rankingKey = most_read.rankingKey)`, [sourceId]);
            const index = await loadRankingArticleIndex(sourceId, database, rows.map(row => row.canonicalUrl));
            for (const row of rows) {
                const articleId = index.get(cleanHttpUrl(row.canonicalUrl))?.[0]?.id || null;
                if (articleId === row.articleId) continue;
                const result = await run('UPDATE most_read SET articleId = ? WHERE id = ?', [articleId, row.id]);
                updated += result.changes;
            }
        }
        return updated;
    });
}

async function setRankingStatus(state, attemptedAt) {
    const status = normalizeRankingStatus({ state, attemptedAt });
    await run(`INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    [RANKING_STATUS_KEY, JSON.stringify(status)]);
    publish('rankings.updated', status);
}

function failureDetails(error) {
    const details = [];
    const seen = new Set();
    for (let failure = error; failure && details.length < 3 && !seen.has(failure); failure = failure.cause) {
        seen.add(failure);
        details.push({ message: String(failure.message || failure).slice(0, 2_000), phase: failure.phase || null, code: failure.code || null });
    }
    return details;
}

export async function refreshMostReadRankings({ capture = fetchGolemRankings } = {}) {
    const attemptedAt = new Date().toISOString();
    await setRankingStatus('refreshing', attemptedAt);
    try {
        // Reconcile even when the publisher is unavailable, so newly imported
        // RSS articles can open the last successful ranking in the viewer.
        await reconcileMostReadArticles();
        const rows = await all(`SELECT sources.id, sources.name, sources.websiteUrl, feeds.feedUrl
            FROM sources JOIN feeds ON feeds.sourceId = sources.id ORDER BY sources.id, feeds.id`);
        const sources = new Map(rows.filter(row => cleanHttpUrl(row.feedUrl) && isGolemSource(row)).map(row => [row.id, row]));
        let updated = 0;
        let failed = false;
        for (const source of sources.values()) {
            try {
                const snapshot = await capture();
                const result = await saveMostReadSnapshot({ sourceId: source.id, ...snapshot });
                if (result.inserted) updated += 1;
            } catch (error) {
                failed = true;
                logWarn('Publisher rankings refresh failed', { sourceId: source.id, error: error.message, failures: failureDetails(error) });
            }
        }
        await setRankingStatus(failed ? 'error' : sources.size ? 'ready' : 'idle', attemptedAt);
        return { updated, total: sources.size };
    } catch (error) {
        await setRankingStatus('error', attemptedAt);
        throw error;
    }
}
