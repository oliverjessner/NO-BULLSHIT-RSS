import { invokeDesktop, isDesktop } from '../services/desktop.js';

const FEED_EXPORT_PAGE_SIZE = 250;

const FORMAT_CONFIG = Object.freeze({
    markdown: { extension: 'md', mimeType: 'text/markdown;charset=utf-8' },
    json: { extension: 'json', mimeType: 'application/json;charset=utf-8' },
    csv: { extension: 'csv', mimeType: 'text/csv;charset=utf-8' },
    links: { extension: 'txt', mimeType: 'text/plain;charset=utf-8' },
});

function pad(value) {
    return String(value).padStart(2, '0');
}

function localDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTime(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '—';
    return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localTime(value) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '—';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function singleLine(value, fallback = '') {
    return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function textValue(value, fallback = '') {
    return String(value || fallback).trim();
}

function topicLabels(topics) {
    const labels = new Map();
    for (const topic of Array.isArray(topics) ? topics : []) {
        const label = singleLine(typeof topic === 'string' ? topic : topic?.label || topic?.slug);
        if (label && !labels.has(label.toLowerCase())) labels.set(label.toLowerCase(), label);
    }
    return [...labels.values()];
}

function articleForExport(article) {
    return {
        id: Number.isInteger(Number(article?.id)) ? Number(article.id) : null,
        title: textValue(article?.title, 'Untitled'),
        url: String(article?.url || '').trim(),
        sourceName: textValue(article?.sourceName, 'Unknown source'),
        publishedAt: article?.publishedAt || null,
        topics: topicLabels(article?.topics),
        bullshit: Boolean(article?.bullshit),
        bullshitRules: (Array.isArray(article?.bullshitRules) ? article.bullshitRules : []).map(rule => singleLine(rule)).filter(Boolean),
    };
}

function csvField(value) {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows) {
    return rows.map(row => row.map(csvField).join(',')).join('\r\n');
}

function safeFilenameSegment(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

function exportConfig(format) {
    const config = FORMAT_CONFIG[format];
    if (!config) throw new Error(`Unsupported export format: ${format}`);
    return config;
}

export async function fetchAllFeedArticles(fetchPage, filterParams, { pageSize = FEED_EXPORT_PAGE_SIZE } = {}) {
    if (typeof fetchPage !== 'function') throw new TypeError('fetchPage must be a function');
    const normalizedPageSize = Math.max(1, Math.min(Number(pageSize) || FEED_EXPORT_PAGE_SIZE, FEED_EXPORT_PAGE_SIZE));
    const filters = new URLSearchParams(filterParams || '');
    for (const [name, value] of [...filters]) if (!value) filters.delete(name);

    const articles = [];
    const seenIds = new Set();
    let cursor = null;

    while (true) {
        const params = new URLSearchParams(filters);
        params.set('limit', String(normalizedPageSize));
        if (cursor) {
            params.set('cursorPublishedAt', cursor.publishedAt);
            params.set('cursorId', String(cursor.id));
        }

        const payload = await fetchPage(params);
        const page = Array.isArray(payload) ? payload : [];
        for (const article of page) {
            const id = Number(article?.id);
            if (!Number.isInteger(id) || id <= 0 || seenIds.has(id)) continue;
            seenIds.add(id);
            articles.push(article);
        }
        if (page.length < normalizedPageSize) break;

        const last = page.at(-1);
        const nextCursor = {
            publishedAt: String(last?.publishedAt || ''),
            id: Number(last?.id),
        };
        if (!nextCursor.publishedAt || !Number.isInteger(nextCursor.id) || nextCursor.id <= 0) {
            throw new Error('Could not continue the feed export pagination.');
        }
        if (cursor && cursor.publishedAt === nextCursor.publishedAt && cursor.id === nextCursor.id) {
            throw new Error('Feed export pagination did not advance.');
        }
        cursor = nextCursor;
    }

    return articles;
}

function feedMarkdown(articles, filters, filterLabels, exportedAt) {
    const lines = ['# Feed Export', '', `Exported: ${localDate(exportedAt)}`];
    if (filters.query) lines.push(`Search: ${singleLine(filters.query)}`);
    if (filters.topic) lines.push(`Topic: ${singleLine(filterLabels.topic || filters.topic)}`);
    if (filters.source) lines.push(`Source: ${singleLine(filterLabels.source || filters.source)}`);
    if (filters.listId) lines.push(`List: ${singleLine(filterLabels.list || filters.listId)}`);
    if (filters.bullshit) lines.push(`Bullshit: ${singleLine(filters.bullshit)}`);

    for (const article of articles) {
        lines.push('', `## ${singleLine(article.title)}`, '', `Source: ${singleLine(article.sourceName)}`, `Published: ${localDateTime(article.publishedAt)}`);
        if (article.topics.length) lines.push(`Topics: ${article.topics.join(', ')}`);
        if (article.url) lines.push('', article.url);
    }
    return `${lines.join('\n')}\n`;
}

function feedCsv(articles) {
    return `${csv([
        ['title', 'url', 'source', 'published_at', 'topics'],
        ...articles.map(article => [article.title, article.url, article.sourceName, article.publishedAt || '', article.topics.join(', ')]),
    ])}\r\n`;
}

function linkList(articles) {
    const links = articles.map(article => article.url).filter(Boolean);
    return links.length ? `${links.join('\n')}\n` : '';
}

export function createFeedExport(format, { articles = [], filters = {}, filterLabels = {}, exportedAt = new Date() } = {}) {
    const config = exportConfig(format);
    const normalizedArticles = articles.map(articleForExport);
    const normalizedFilters = {
        query: filters.query || null,
        topic: filters.topic || null,
        source: filters.source || null,
        listId: filters.listId ? Number(filters.listId) || String(filters.listId) : null,
        bullshit: filters.bullshit || null,
    };
    let content;
    if (format === 'markdown') content = feedMarkdown(normalizedArticles, normalizedFilters, filterLabels, exportedAt);
    else if (format === 'json') content = `${JSON.stringify({ exportedAt: new Date(exportedAt).toISOString(), filters: normalizedFilters, articles: normalizedArticles }, null, 2)}\n`;
    else if (format === 'csv') content = feedCsv(normalizedArticles);
    else content = linkList(normalizedArticles);

    const querySegment = safeFilenameSegment(normalizedFilters.query);
    const filenameParts = ['no-bullshit-rss-feed'];
    if (querySegment) filenameParts.push(querySegment);
    filenameParts.push(localDate(exportedAt));
    return { content, mimeType: config.mimeType, filename: `${filenameParts.join('-')}.${config.extension}` };
}

function dateBounds(items) {
    const dated = items
        .map(item => ({ value: item?.publishedAt || null, time: Date.parse(item?.publishedAt) }))
        .filter(item => Number.isFinite(item.time))
        .sort((left, right) => left.time - right.time);
    return { firstReport: dated[0]?.value || null, latestReport: dated.at(-1)?.value || null };
}

function digestStories(clusters) {
    return (Array.isArray(clusters) ? clusters : []).map(cluster => {
        const items = Array.isArray(cluster?.items) ? cluster.items : [];
        const representative = cluster?.representative || items[0] || {};
        const sources = new Set(items.map(item => singleLine(item?.sourceName, 'Unknown source')));
        const topics = topicLabels(items.flatMap(item => Array.isArray(item?.topics) ? item.topics : []));
        return {
            title: textValue(cluster?.clusterTitle || representative?.title, 'Untitled'),
            topics,
            sourceCount: sources.size,
            ...dateBounds(items),
            articles: items.map(articleForExport),
        };
    });
}

function digestMarkdown(variant, stories, exportedAt) {
    const labels = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
    const totalArticles = stories.reduce((sum, story) => sum + story.articles.length, 0);
    const lines = [`# ${labels[variant] || labels.day} Digest – ${localDate(exportedAt)}`, '', `${stories.length} stories · ${totalArticles} sources`];
    for (const story of stories) {
        lines.push('', `## ${singleLine(story.title)}`, '', `Sources: ${story.sourceCount}`);
        if (story.topics.length) lines.push(`Topics: ${story.topics.join(', ')}`);
        lines.push(`First report: ${localTime(story.firstReport)}`, `Latest report: ${localTime(story.latestReport)}`);
        for (const article of story.articles) {
            lines.push('', `- ${singleLine(article.sourceName)} — ${singleLine(article.title)}`);
            if (article.url) lines.push(`  ${article.url}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

function digestCsv(stories) {
    const rows = [['story_title', 'story_index', 'story_sources', 'article_title', 'source', 'url', 'published_at', 'topics']];
    stories.forEach((story, index) => {
        story.articles.forEach(article => {
            rows.push([story.title, index + 1, story.sourceCount, article.title, article.sourceName, article.url, article.publishedAt || '', article.topics.join(', ')]);
        });
    });
    return `${csv(rows)}\r\n`;
}

export function createDigestExport(format, { variant = 'day', clusters = [], exportedAt = new Date() } = {}) {
    const config = exportConfig(format);
    const normalizedVariant = ['day', 'week', 'month'].includes(variant) ? variant : 'day';
    const stories = digestStories(clusters);
    let content;
    if (format === 'markdown') content = digestMarkdown(normalizedVariant, stories, exportedAt);
    else if (format === 'json') content = `${JSON.stringify({ variant: normalizedVariant, exportedAt: new Date(exportedAt).toISOString(), stories }, null, 2)}\n`;
    else if (format === 'csv') content = digestCsv(stories);
    else content = linkList(stories.flatMap(story => story.articles));
    return {
        content,
        mimeType: config.mimeType,
        filename: `no-bullshit-rss-digest-${normalizedVariant}-${localDate(exportedAt)}.${config.extension}`,
    };
}

export async function downloadExport({ content, mimeType, filename }) {
    if (isDesktop) return invokeDesktop('save_export', { content, filename });
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
}
