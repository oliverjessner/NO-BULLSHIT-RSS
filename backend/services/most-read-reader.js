import { cleanHttpUrl } from '../utils/url.js';
import { loadTopicsByArticleIds } from './article-queries.js';

const articleUrlKeys = row => [...new Set([cleanHttpUrl(row.canonicalUrl), cleanHttpUrl(row.url)].filter(Boolean))];

export async function loadRankingArticleIndex(sourceId, database, canonicalUrls) {
    const requested = new Set((canonicalUrls || []).map(cleanHttpUrl).filter(Boolean));
    if (!requested.size) return new Map();
    const select = `SELECT articles.id, articles.feedId, articles.title, articles.teaser, articles.content,
            articles.url, articles.canonicalUrl, articles.publishedAt, articles.externalId AS guidOrHash,
            ${database.feedNamesAvailable === false ? 'sources.name' : "COALESCE(NULLIF(feeds.name, ''), sources.name)"} AS sourceName,
            sources.logo IS NOT NULL AS hasSourceLogo, feeds.feedUrl,
            EXISTS (SELECT 1 FROM digest_excluded_feeds WHERE feedId = feeds.id) AS excluded,
            ${database.bullshitRulesAvailable === false ? '0' : 'EXISTS (SELECT 1 FROM article_bullshit_matches WHERE articleId = articles.id)'} AS bullshit
        FROM articles JOIN feeds ON feeds.id = articles.feedId JOIN sources ON sources.id = feeds.sourceId
        WHERE feeds.sourceId = ?`;
    const urlsJson = JSON.stringify([...requested]);
    const rows = await database.all(`${select}
        AND (articles.canonicalUrl IN (SELECT value FROM json_each(?)) OR articles.url IN (SELECT value FROM json_each(?)))`,
    [sourceId, urlsJson, urlsJson]);
    const known = new Set(rows.map(row => row.id));
    const unresolved = new Set([...requested].filter(url => !rows.some(row =>
        articleUrlKeys(row).includes(url) && cleanHttpUrl(row.feedUrl) && !row.excluded && !row.bullshit)));
    if (unresolved.size) {
        // Legacy URLs may still contain tracking parameters. Only scan their
        // small URL fields, then hydrate the few matching articles.
        const legacy = await database.all(`SELECT articles.id, articles.url, articles.canonicalUrl
            FROM articles JOIN feeds ON feeds.id = articles.feedId WHERE feeds.sourceId = ?`, [sourceId]);
        const ids = legacy.filter(row => !known.has(row.id) && articleUrlKeys(row).some(key => unresolved.has(key))).map(row => row.id);
        if (ids.length) rows.push(...await database.all(`${select} AND articles.id IN (SELECT value FROM json_each(?))`, [sourceId, JSON.stringify(ids)]));
    }
    const index = new Map();
    for (const row of rows) {
        for (const canonicalUrl of articleUrlKeys(row).filter(key => requested.has(key))) {
            const candidates = index.get(canonicalUrl) || [];
            if (!candidates.some(candidate => candidate.id === row.id)) candidates.push({ ...row, manual: !cleanHttpUrl(row.feedUrl) });
            index.set(canonicalUrl, candidates);
        }
    }
    for (const candidates of index.values()) candidates.sort((a, b) => Number(a.manual) - Number(b.manual) || b.id - a.id);
    return index;
}

export async function readMostReadRankings(database) {
    const tables = await database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'most_read'");
    if (!tables.length) return [];
    const rows = await database.all(`SELECT most_read.*, sources.name AS sourceName
        FROM most_read JOIN sources ON sources.id = most_read.sourceId
        WHERE capturedAt = (SELECT MAX(latest.capturedAt) FROM most_read AS latest
            WHERE latest.sourceId = most_read.sourceId AND latest.rankingKey = most_read.rankingKey)
        AND EXISTS (SELECT 1 FROM feeds WHERE feeds.sourceId = sources.id
            AND (feeds.feedUrl LIKE 'https://%' OR feeds.feedUrl LIKE 'http://%')
            AND NOT EXISTS (SELECT 1 FROM digest_excluded_feeds WHERE feedId = feeds.id))
        ORDER BY sources.name COLLATE NOCASE, most_read.sourceId, most_read.rankingKey, most_read.rank`);
    const groups = new Map();
    const indexes = new Map();
    const articleIds = [];
    for (const sourceId of new Set(rows.map(row => row.sourceId))) {
        indexes.set(sourceId, await loadRankingArticleIndex(sourceId, database, rows.filter(row => row.sourceId === sourceId).map(row => row.canonicalUrl)));
    }
    for (const row of rows) {
        const key = `${row.sourceId}:${row.rankingKey}`;
        if (!groups.has(key)) groups.set(key, {
            sourceId: Number(row.sourceId), sourceName: row.sourceName,
            rankingKey: row.rankingKey, capturedAt: row.capturedAt, items: [],
        });
        const canonicalUrl = cleanHttpUrl(row.canonicalUrl);
        if (!canonicalUrl) continue;
        const candidates = indexes.get(row.sourceId).get(canonicalUrl) || [];
        const rssCandidates = candidates.filter(article => !article.manual);
        const preferred = rssCandidates.length ? rssCandidates : candidates;
        const match = preferred.find(article => !article.excluded && !article.bullshit);
        if (preferred.length && !match) continue;
        let article = null;
        if (match) {
            article = {
                id: Number(match.id), feedId: Number(match.feedId), title: match.title, teaser: match.teaser, content: match.content,
                url: cleanHttpUrl(match.url) || canonicalUrl, publishedAt: match.publishedAt, guidOrHash: match.guidOrHash, sourceName: match.sourceName,
                sourceLogoDataUrl: match.hasSourceLogo ? `/api/feeds/${encodeURIComponent(match.feedId)}/logo` : null,
                topics: [],
            };
            articleIds.push(article.id);
        }
        groups.get(key).items.push({
            id: Number(row.id), articleId: article?.id || null, canonicalUrl, title: row.title,
            rank: Number(row.rank), article,
        });
    }
    const topics = await loadTopicsByArticleIds(articleIds, database);
    for (const group of groups.values()) for (const item of group.items) {
        if (item.article) item.article.topics = topics.get(item.article.id) || [];
    }
    return [...groups.values()];
}
