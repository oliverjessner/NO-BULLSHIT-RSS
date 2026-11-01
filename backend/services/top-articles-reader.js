import { cleanHttpUrl } from '../utils/url.js';
import { loadTopicsByArticleIds } from './article-queries.js';
import { loadRankingArticleIndex } from './most-read-reader.js';
import { RANKING_MEDIA, rankingMediumForSource } from './ranking-media.js';
import { readRankingRefreshStatus } from './ranking-status.js';

const labels = { most_read: 'Most read', most_commented: 'Most commented', top_news: 'Top-News' };
const invalid = message => Object.assign(new Error(message), { status: 400 });
const timestamp = value => {
    // SQLite's unqualified datetime strings represent UTC in this database.
    const normalized = typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
        ? `${value.replace(' ', 'T')}Z` : value;
    const result = Date.parse(normalized);
    return Number.isFinite(result) ? result : null;
};

function decodeCursor(cursor, medium) {
    if (cursor === null || cursor === undefined) return null;
    try {
        if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (value.v !== 1 || value.medium !== medium || !Number.isSafeInteger(value.watermark) || value.watermark < 0
            || !Number.isSafeInteger(value.time) || !Number.isSafeInteger(value.id) || value.id <= 0) throw new Error();
        return value;
    } catch { throw invalid('Invalid top-article cursor. Start a new page for the selected medium.'); }
}

function pickArticle(candidates = []) {
    const rss = candidates.filter(article => !article.manual);
    const preferred = rss.length ? rss : candidates;
    return { article: preferred.find(article => !article.bullshit && !article.dismissedAt), blocked: preferred.length > 0 };
}

function articleData(article, fallback) {
    if (!article) return {
        id: null, feedId: null, title: fallback.title || fallback.canonicalUrl, teaser: '', content: null,
        url: fallback.canonicalUrl, publishedAt: null, sourceName: fallback.source.name || fallback.provider.name,
        sourceLogoDataUrl: null, topics: [], saved: false,
    };
    return {
        id: Number(article.id), feedId: Number(article.feedId), title: article.title, teaser: article.teaser || '',
        content: article.content, url: cleanHttpUrl(article.url) || fallback.canonicalUrl, publishedAt: article.publishedAt,
        sourceName: article.sourceName, guidOrHash: article.guidOrHash, createdAt: article.createdAt, updatedAt: article.updatedAt,
        readAt: article.readAt, dismissedAt: article.dismissedAt, saved: Boolean(article.saved), topics: [],
        sourceLogoDataUrl: article.hasSourceLogo ? `/api/feeds/${encodeURIComponent(article.feedId)}/logo` : null,
    };
}

/** Read distinct articles from saved publisher history, without fetching or writing. */
export async function readTopArticles(database, {
    medium = 'all', limit = 40, cursor = null, maxLimit = 100, includeContent = true,
} = {}) {
    if (medium !== 'all' && !RANKING_MEDIA.some(provider => provider.id === medium)) throw invalid('Unsupported ranking medium.');
    if (!Number.isSafeInteger(limit) || limit < 1 || (maxLimit !== null && limit > maxLimit)) throw invalid('Invalid top-article limit.');
    const position = decodeCursor(cursor, medium);
    const sourceRows = await database.all(`SELECT sources.id, sources.name, sources.websiteUrl, feeds.feedUrl
        FROM sources JOIN feeds ON feeds.sourceId = sources.id ORDER BY sources.id, feeds.id`);
    const sources = new Map();
    for (const source of sourceRows) {
        const provider = rankingMediumForSource(source);
        if (cleanHttpUrl(source.feedUrl) && provider && (medium === 'all' || provider.id === medium)) sources.set(Number(source.id), { source, provider });
    }
    const result = {
        medium, media: RANKING_MEDIA.map(({ id, name }) => ({ id, name })), configured: sources.size > 0,
        items: [], hasMore: false, nextCursor: null,
        rankingStatus: await readRankingRefreshStatus(database, medium === 'all' ? null : medium),
    };
    const tables = await database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'most_read'");
    if (!sources.size || !tables.length) return result;
    const maximum = await database.all('SELECT COALESCE(MAX(id), 0) AS id FROM most_read');
    const watermark = position?.watermark ?? Number(maximum[0]?.id || 0);
    // Retain the last association of each URL and selection type, while keeping
    // older distinct articles available in the collected history.
    const rows = await database.all(`SELECT * FROM (
        SELECT most_read.*, ROW_NUMBER() OVER (
            PARTITION BY sourceId, rankingKey, canonicalUrl ORDER BY capturedAt DESC, id DESC
        ) AS associationPosition FROM most_read
        WHERE id <= ? AND sourceId IN (SELECT value FROM json_each(?))
    ) WHERE associationPosition = 1 ORDER BY capturedAt DESC, id DESC`, [watermark, JSON.stringify([...sources.keys()])]);
    const buckets = new Map();
    const requestedBySource = new Map();
    for (const row of rows) {
        const { source, provider } = sources.get(Number(row.sourceId));
        const canonicalUrl = cleanHttpUrl(row.canonicalUrl);
        if (!canonicalUrl || new URL(canonicalUrl).hostname.toLowerCase().replace(/^www\./, '') !== provider.hostname
            || !provider.rankingKeys.includes(row.rankingKey) || timestamp(row.capturedAt) === null) continue;
        const entry = { ...row, id: Number(row.id), sourceId: Number(row.sourceId), canonicalUrl, source, provider };
        if (!buckets.has(canonicalUrl)) buckets.set(canonicalUrl, []);
        buckets.get(canonicalUrl).push(entry);
        if (!requestedBySource.has(entry.sourceId)) requestedBySource.set(entry.sourceId, new Set());
        requestedBySource.get(entry.sourceId).add(canonicalUrl);
    }
    // Sorting needs only metadata. Full RSS bodies are loaded for the requested
    // page, so browsing history does not hydrate every saved article's content.
    const metadata = new Map();
    for (const [sourceId, urls] of requestedBySource) {
        metadata.set(sourceId, await loadRankingArticleIndex(sourceId, database, [...urls], { includeContent: false, includeTeaser: false }));
    }
    const candidates = [];
    for (const [canonicalUrl, associations] of buckets) {
        let matched = null, blocked = false;
        for (const entry of associations) {
            const selected = pickArticle(metadata.get(entry.sourceId)?.get(canonicalUrl));
            blocked ||= selected.blocked;
            if (selected.article) { matched = { sourceId: entry.sourceId, article: selected.article }; break; }
        }
        if (!matched && blocked) continue;
        const primary = associations[0];
        const time = timestamp(matched?.article.publishedAt) ?? timestamp(primary.capturedAt);
        if (position && !(time < position.time || (time === position.time && primary.id < position.id))) continue;
        const rankings = new Map();
        for (const entry of associations) {
            const key = `${entry.provider.id}:${entry.rankingKey}`;
            if (!rankings.has(key)) rankings.set(key, {
                medium: entry.provider.id, mediumName: entry.provider.name, sourceId: entry.sourceId,
                rankingKey: entry.rankingKey, label: entry.provider.rankingLabels?.[entry.rankingKey] || labels[entry.rankingKey],
                rank: Number(entry.rank), capturedAt: entry.capturedAt,
            });
        }
        candidates.push({ ...primary, time, matched, rankings: [...rankings.values()] });
    }
    candidates.sort((left, right) => right.time - left.time || right.id - left.id);
    const page = candidates.slice(0, limit);
    const hydrated = new Map();
    {
        const pageUrls = new Map();
        for (const entry of page) if (entry.matched) {
            const sourceId = entry.matched.sourceId;
            if (!pageUrls.has(sourceId)) pageUrls.set(sourceId, new Set());
            pageUrls.get(sourceId).add(entry.canonicalUrl);
        }
        for (const [sourceId, urls] of pageUrls) hydrated.set(sourceId, await loadRankingArticleIndex(sourceId, database, [...urls], { includeContent }));
    }
    for (const entry of page) {
        const selected = entry.matched ? pickArticle(hydrated.get(entry.matched.sourceId)?.get(entry.canonicalUrl)) : null;
        if (selected?.blocked && !selected.article) continue;
        const article = selected?.article || entry.matched?.article;
        result.items.push({
            ...articleData(article, entry), canonicalUrl: entry.canonicalUrl, medium: entry.provider.id,
            capturedAt: entry.capturedAt, rankingKey: entry.rankingKey, rank: Number(entry.rank), rankings: entry.rankings,
        });
    }
    const topics = await loadTopicsByArticleIds(result.items.filter(item => item.id).map(item => item.id), database);
    for (const item of result.items) if (item.id) item.topics = topics.get(item.id) || [];
    result.hasMore = candidates.length > page.length;
    if (result.hasMore && page.length) {
        const last = page.at(-1);
        result.nextCursor = Buffer.from(JSON.stringify({ v: 1, medium, watermark, time: last.time, id: last.id })).toString('base64url');
    }
    return result;
}
