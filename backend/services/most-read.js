import { all, get, run, transaction } from '../database/datenbank.js';
import { cleanHttpUrl } from '../utils/url.js';
import { logWarn } from '../utils/logger.js';
import { fetchGolemRankings } from './golem-rankings.js';
import { fetchWinFutureRankings } from './winfuture-rankings.js';
import { fetchComputerBaseRankings } from './computerbase-rankings.js';
import { fetchHeiseIxRankings } from './heise-ix-rankings.js';
import { rankingMediumForSource, RANKING_KEYS, RANKING_MEDIA } from './ranking-media.js';
import { loadRankingArticleIndex } from './most-read-reader.js';
import { normalizeRankingStatus, rankingStatusKey } from './ranking-status.js';
import { publish } from './events.js';

const database = { all, get };
const host = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
const publisherCaptures = { golem: fetchGolemRankings, winfuture: fetchWinFutureRankings, computerbase: fetchComputerBaseRankings, 'heise-ix': fetchHeiseIxRankings };

function validateRankings(rankings, websiteUrl) {
    const requiredKeys = rankingMediumForSource({ websiteUrl })?.rankingKeys || RANKING_KEYS;
    if (!rankings || Object.keys(rankings).some(key => !requiredKeys.includes(key))) throw new Error('Invalid ranking keys');
    return requiredKeys.flatMap(rankingKey => {
        const items = rankings[rankingKey];
        if (!Array.isArray(items) || !items.length || items.length > 50) throw new Error(requiredKeys.length === 2
            ? 'Both complete article rankings are required' : `A complete ${rankingKey === 'top_news' ? 'Top-News' : 'most-read'} article ranking is required`);
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
        const provider = source && rankingMediumForSource(source);
        const hasRss = source && feeds.some(feed => cleanHttpUrl(feed.feedUrl)
            && (!provider?.feedPath || rankingMediumForSource({ ...source, feedUrl: feed.feedUrl })?.id === provider.id));
        if (!source || !cleanHttpUrl(source.websiteUrl) || !hasRss) throw new Error('Ranking source requires an RSS feed for that medium');
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

async function setRankingStatus(state, attemptedAt, errorCode = null, medium = null) {
    const status = normalizeRankingStatus({ state, attemptedAt, errorCode });
    await run(`INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    [rankingStatusKey(medium), JSON.stringify(status)]);
    publish('rankings.updated', { ...status, ...(medium ? { medium } : {}) });
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

let activeRankingRefresh = null;
export const isRankingRefreshRunning = () => activeRankingRefresh !== null;

export function refreshMostReadRankings(options = {}) {
    if (!activeRankingRefresh) activeRankingRefresh = refreshRankings(options).finally(() => { activeRankingRefresh = null; });
    return activeRankingRefresh;
}

async function refreshRankings({ capture, medium = null } = {}) {
    if (medium && !RANKING_MEDIA.some(item => item.id === medium)) throw new Error('Unsupported ranking medium');
    const attemptedAt = new Date().toISOString();
    const requested = RANKING_MEDIA.filter(item => !medium || item.id === medium);
    // Only an all-publisher pass advances the independent scheduler's cadence.
    if (!medium) await setRankingStatus('refreshing', attemptedAt);
    for (const provider of requested) await setRankingStatus('refreshing', attemptedAt, null, provider.id);
    try {
        // Reconcile even when the publisher is unavailable, so newly imported
        // RSS articles can open the last successful ranking in the viewer.
        await reconcileMostReadArticles();
        const rows = await all(`SELECT sources.id, sources.name, sources.websiteUrl, feeds.feedUrl
            FROM sources JOIN feeds ON feeds.sourceId = sources.id ORDER BY sources.id, feeds.id`);
        const sources = new Map(rows.filter(row => {
            const provider = rankingMediumForSource(row);
            return cleanHttpUrl(row.feedUrl) && provider && (!medium || provider.id === medium);
        }).map(row => [row.id, row]));
        let updated = 0;
        const outcomes = new Map(requested.map(provider => [provider.id, { total: 0, failed: false, errorCode: null }]));
        for (const source of sources.values()) {
            const provider = rankingMediumForSource(source);
            const outcome = outcomes.get(provider.id);
            outcome.total += 1;
            try {
                const read = capture || publisherCaptures[provider.id];
                const snapshot = await read({ medium: provider.id, source });
                const result = await saveMostReadSnapshot({ sourceId: source.id, ...snapshot });
                if (result.inserted) updated += 1;
            } catch (error) {
                outcome.failed = true;
                if (error.code === 'GOLEM_CONSENT_REQUIRED') outcome.errorCode = error.code;
                logWarn('Publisher rankings refresh failed', { sourceId: source.id, error: error.message, failures: failureDetails(error) });
            }
        }
        for (const [id, outcome] of outcomes) {
            await setRankingStatus(outcome.failed ? 'error' : outcome.total ? 'ready' : 'idle', attemptedAt, outcome.errorCode, id);
        }
        if (!medium) {
            const failed = [...outcomes.values()].some(outcome => outcome.failed);
            const failureCode = [...outcomes.values()].find(outcome => outcome.errorCode)?.errorCode || null;
            await setRankingStatus(failed ? 'error' : sources.size ? 'ready' : 'idle', attemptedAt, failureCode);
        }
        return { updated, total: sources.size };
    } catch (error) {
        for (const provider of requested) await setRankingStatus('error', attemptedAt, error.code, provider.id);
        if (!medium) await setRankingStatus('error', attemptedAt, error.code);
        throw error;
    }
}
