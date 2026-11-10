import { normalizePublisherRankings, normalizeTopArticles } from '../components/publisher-rankings.js';

const FORMATS = {
    markdown: ['md', 'text/markdown;charset=utf-8'],
    json: ['json', 'application/json;charset=utf-8'],
    csv: ['csv', 'text/csv;charset=utf-8'],
    links: ['txt', 'text/plain;charset=utf-8'],
};
const text = (value, fallback = '') => String(value || fallback).trim();
const singleLine = value => text(value).replace(/\s+/gu, ' ');
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function mergeTopArticles(items) {
    const articles = new Map();
    for (const item of items) {
        const article = normalizeTopArticles([item])[0];
        if (!article) continue;
        const previous = articles.get(article.canonicalUrl);
        const rankings = new Map();
        for (const ranking of [...(previous?.rankings || []), ...article.rankings]) {
            const key = JSON.stringify([ranking.medium, ranking.sourceId, ranking.rankingKey, ranking.rank, ranking.capturedAt]);
            if (!rankings.has(key)) rankings.set(key, ranking);
        }
        articles.set(article.canonicalUrl, { ...(previous || article), rankings: [...rankings.values()] });
    }
    return [...articles.values()];
}

export async function fetchAllTopArticles(fetchPage) {
    if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
    const cursors = new Set();
    const items = [];
    let cursor;
    while (true) {
        const payload = await fetchPage({ limit: 100, ...(cursor ? { cursor } : {}) });
        if (payload?.medium !== 'all' || !Array.isArray(payload.items) || typeof payload.hasMore !== 'boolean'
            || (payload.hasMore && (typeof payload.nextCursor !== 'string' || !payload.nextCursor.trim()))) {
            throw new Error('Invalid top articles export response.');
        }
        items.push(...payload.items);
        if (!payload.hasMore) return { ...payload, items: mergeTopArticles(items) };
        if (cursors.has(payload.nextCursor)) throw new Error('Top articles export pagination did not advance.');
        cursor = payload.nextCursor;
        cursors.add(cursor);
    }
}

function topicLabels(topics) {
    const labels = new Map();
    for (const topic of Array.isArray(topics) ? topics : []) {
        const label = singleLine(typeof topic === 'string' ? topic : topic?.label || topic?.slug);
        if (label && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
    }
    return [...labels.values()];
}

function exportArticles(payload, mediumName) {
    const items = payload.medium === 'all' ? payload.items : normalizePublisherRankings(payload.rankings).flatMap(group => group.items.map(item => ({
        ...item.article,
        id: item.articleId,
        title: item.article?.title || item.title,
        url: item.article?.url || item.canonicalUrl,
        canonicalUrl: item.canonicalUrl,
        sourceName: item.article?.sourceName || group.sourceName,
        rankings: [{
            medium: payload.medium, mediumName, sourceId: group.sourceId, sourceName: group.sourceName,
            rankingKey: group.rankingKey, label: group.label, rank: item.rank, capturedAt: group.capturedAt,
        }],
    })));
    return mergeTopArticles(items).map(article => ({
        id: positiveId(article.id),
        title: text(article.title, article.canonicalUrl),
        url: article.url,
        canonicalUrl: article.canonicalUrl,
        sourceName: text(article.sourceName, 'Unknown source'),
        publishedAt: article.publishedAt || null,
        topics: topicLabels(article.topics),
        bullshit: Boolean(article.bullshit),
        bullshitRules: (Array.isArray(article.bullshitRules) ? article.bullshitRules : []).map(singleLine).filter(Boolean),
        rankings: article.rankings.map(ranking => ({
            medium: ranking.medium || article.medium || payload.medium,
            mediumName: ranking.mediumName || payload.media?.find(item => item.id === ranking.medium)?.name || mediumName,
            sourceId: positiveId(ranking.sourceId),
            sourceName: text(ranking.sourceName, article.sourceName || 'Unknown source'),
            rankingKey: ranking.rankingKey,
            label: ranking.label,
            rank: ranking.rank,
            capturedAt: ranking.capturedAt || null,
        })),
    }));
}

function localDate(value) {
    const date = new Date(value);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function markdown(articles, medium, mediumName, exportedAt) {
    const lines = ['# Most read Export', '', `Exported: ${localDate(exportedAt)}`, `Medium: ${singleLine(mediumName)} (${medium})`];
    for (const article of articles) {
        lines.push('', `## ${singleLine(article.title)}`, '', `Source: ${singleLine(article.sourceName)}`, `Published: ${article.publishedAt || '—'}`);
        if (article.topics.length) lines.push(`Topics: ${article.topics.join(', ')}`);
        for (const ranking of article.rankings) {
            lines.push(`Ranking: ${singleLine(ranking.label)} #${ranking.rank} (${ranking.rankingKey}) · Medium: ${singleLine(ranking.mediumName)} · Source: ${singleLine(ranking.sourceName)}${ranking.sourceId ? ` (ID ${ranking.sourceId})` : ''} · Captured: ${singleLine(ranking.capturedAt || '—')}`);
        }
        lines.push('', article.url);
    }
    return `${lines.join('\n')}\n`;
}

function csv(articles) {
    const rows = [['title', 'url', 'source', 'published_at', 'topics', 'canonical_url', 'article_id', 'medium', 'ranking_key', 'ranking_label', 'rank', 'ranking_source_id', 'ranking_source', 'captured_at']];
    for (const article of articles) {
        for (const ranking of article.rankings.length ? article.rankings : [{}]) {
            rows.push([article.title, article.url, article.sourceName, article.publishedAt, article.topics.join(', '), article.canonicalUrl, article.id,
                ranking.medium, ranking.rankingKey, ranking.label, ranking.rank, ranking.sourceId, ranking.sourceName, ranking.capturedAt]);
        }
    }
    return `${rows.map(row => row.map(value => {
        const field = value == null ? '' : String(value);
        return /[",\r\n]/u.test(field) ? `"${field.replace(/"/gu, '""')}"` : field;
    }).join(',')).join('\r\n')}\r\n`;
}

export function createRankingsExport(format, { payload, exportedAt = new Date() } = {}) {
    if (!Object.hasOwn(FORMATS, format)) throw new Error(`Unsupported export format: ${format}`);
    if (!payload || typeof payload.medium !== 'string' || !payload.medium || !Array.isArray(payload.medium === 'all' ? payload.items : payload.rankings)) {
        throw new Error('Invalid rankings export response.');
    }
    const mediumName = payload.medium === 'all' ? 'All media' : payload.media?.find(item => item.id === payload.medium)?.name || payload.medium;
    const articles = exportArticles(payload, mediumName);
    let content;
    if (format === 'json') content = `${JSON.stringify({ exportedAt: new Date(exportedAt).toISOString(), medium: payload.medium, mediumName, articles }, null, 2)}\n`;
    else if (format === 'markdown') content = markdown(articles, payload.medium, mediumName, exportedAt);
    else if (format === 'csv') content = csv(articles);
    else content = articles.length ? `${[...new Set(articles.map(article => article.url))].join('\n')}\n` : '';
    const segment = payload.medium.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'all';
    const [extension, mimeType] = FORMATS[format];
    return { content, mimeType, filename: `no-bullshit-rss-most-read-${segment}-${localDate(exportedAt)}.${extension}` };
}
