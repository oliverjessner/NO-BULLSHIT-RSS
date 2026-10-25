import { mapArticleRow } from '../routes/digest.js';
import { loadBullshitMatchesByArticleIds } from './bullshit-reader.js';
import { watchdogMatchFilter } from './watchdog-filters.js';

function normalizeArticleIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const set = new Set();
    value.forEach(id => {
        const normalized = Number(id);
        if (Number.isInteger(normalized) && normalized > 0) {
            set.add(normalized);
        }
    });
    return Array.from(set);
}

function chunkArray(items, size = 400) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

export async function loadTopicsByArticleIds(articleIds, { all }) {
    const normalizedArticleIds = normalizeArticleIds(articleIds);
    const topicsByArticleId = new Map();

    if (normalizedArticleIds.length === 0) {
        return topicsByArticleId;
    }

    const articleIdChunks = chunkArray(normalizedArticleIds, 400);
    for (const chunk of articleIdChunks) {
        const topicRows = await all(
            `
            SELECT
                article_topics.articleId AS articleId,
                topics.slug AS topicSlug,
                topics.label AS topicLabel,
                article_topics.score AS score
            FROM article_topics
            JOIN topics ON topics.id = article_topics.topicId
            WHERE article_topics.articleId IN (SELECT value FROM json_each(?))
            ORDER BY article_topics.score DESC, topics.slug ASC
            `,
            [JSON.stringify(chunk)],
        );

        topicRows.forEach(row => {
            const articleId = Number(row.articleId);
            if (!Number.isInteger(articleId) || articleId <= 0) {
                return;
            }
            const existing = topicsByArticleId.get(articleId) || [];
            existing.push({
                slug: row.topicSlug,
                label: row.topicLabel || row.topicSlug,
                score: Number(row.score || 0),
            });
            topicsByArticleId.set(articleId, existing);
        });
    }

    return topicsByArticleId;
}

export async function queryArticles(
    {
        feedId,
        source,
        listId,
        topic,
        noTopic = false,
        query,
        titleContains,
        urlContains,
        limit = 100,
        offset = 0,
        activeOnly = true,
        includeTopics = true,
        maxLimit = 250,
        cursorPublishedAt,
        cursorId,
        bullshit = 'all',
        watchdog,
    } = {},
    { all, feedNamesAvailable = true, bullshitRulesAvailable = true },
) {
    const params = [];
    const whereParts = [];
    const sourceNameExpression = feedNamesAvailable
        ? "COALESCE(NULLIF(feeds.name, ''), sources.name)"
        : 'sources.name';
    const bullshitExpression = bullshitRulesAvailable
        ? 'EXISTS (SELECT 1 FROM article_bullshit_matches WHERE article_bullshit_matches.articleId = articles.id)'
        : '0';

    if (watchdog) {
        const filter = watchdogMatchFilter(watchdog, { match: 'wm', article: 'articles' });
        whereParts.push(`EXISTS (SELECT 1 FROM watchdog_matches wm WHERE wm.articleId = articles.id AND ${filter.where.join(' AND ')})`);
        params.push(...filter.params);
    }

    if (feedId) {
        whereParts.push('feeds.id = ?');
        params.push(feedId);
    } else if (source) {
        whereParts.push([sourceNameExpression, '= ?'].join(' '));
        params.push(source);
    }
    if (listId) {
        whereParts.push('EXISTS (SELECT 1 FROM list_items WHERE list_items.articleId = articles.id AND list_items.listId = ?)');
        params.push(listId);
    }
    if (topic) {
        whereParts.push(`EXISTS (
            SELECT 1 FROM article_topics
            JOIN topics ON topics.id = article_topics.topicId
            WHERE article_topics.articleId = articles.id AND topics.slug = ?
        )`);
        params.push(String(topic).trim().toLowerCase());
    }
    if (noTopic) {
        whereParts.push('NOT EXISTS (SELECT 1 FROM article_topics WHERE article_topics.articleId = articles.id)');
    }
    if (query) {
        const terms = String(query).normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
        if (terms.length > 0) {
            whereParts.push('articles.id IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ?)');
            params.push(terms.slice(0, 12).map(term => `"${term.replace(/"/g, '""')}"*`).join(' AND '));
        }
    }
    if (titleContains) {
        whereParts.push("instr(lower(coalesce(articles.title, '')), lower(?)) > 0");
        params.push(String(titleContains));
    }
    if (urlContains) {
        whereParts.push("instr(lower(coalesce(articles.url, '')), lower(?)) > 0");
        params.push(String(urlContains));
    }
    if (activeOnly) {
        whereParts.push('article_state.dismissedAt IS NULL');
    }
    const normalizedBullshit = String(bullshit || 'all').trim().toLowerCase();
    if (normalizedBullshit === 'clean' && bullshitRulesAvailable) {
        whereParts.push('NOT EXISTS (SELECT 1 FROM article_bullshit_matches WHERE article_bullshit_matches.articleId = articles.id)');
    } else if (normalizedBullshit === 'bullshit') {
        whereParts.push(bullshitRulesAvailable
            ? 'EXISTS (SELECT 1 FROM article_bullshit_matches WHERE article_bullshit_matches.articleId = articles.id)'
            : '0 = 1');
    }
    if (cursorPublishedAt && Number.isInteger(Number(cursorId)) && Number(cursorId) > 0) {
        whereParts.push('(articles.publishedAt < ? OR (articles.publishedAt = ? AND articles.id < ?))');
        params.push(cursorPublishedAt, cursorPublishedAt, Number(cursorId));
    }

    const parsedLimit = Number(limit);
    const parsedOffset = Number(offset);
    const hasUpperLimit = maxLimit !== null && maxLimit !== undefined && Number.isFinite(Number(maxLimit));
    const upperLimit = hasUpperLimit ? Math.max(Math.trunc(Number(maxLimit)), 1) : null;
    const positiveLimit = Number.isFinite(parsedLimit) ? Math.max(Math.trunc(parsedLimit), 1) : 100;
    const normalizedLimit = upperLimit === null ? positiveLimit : Math.min(positiveLimit, upperLimit);
    const normalizedOffset = Number.isFinite(parsedOffset) ? Math.max(Math.trunc(parsedOffset), 0) : 0;

    const selectColumns = [
        `SELECT articles.id, articles.feedId, articles.title, articles.teaser, articles.url,
         articles.publishedAt, articles.createdAt, articles.updatedAt, article_state.dismissedAt,
        `,
        sourceNameExpression,
        `AS sourceName,
         sources.logo IS NOT NULL AS hasSourceLogo,
         EXISTS (SELECT 1 FROM list_items WHERE list_items.articleId = articles.id) AS saved,
         ${bullshitExpression} AS bullshit`,
    ].join('\n');
    const sql = [
        selectColumns,
        'FROM articles',
        'JOIN feeds ON feeds.id = articles.feedId',
        'JOIN sources ON sources.id = feeds.sourceId',
        'LEFT JOIN article_state ON article_state.articleId = articles.id',
        whereParts.length ? ['WHERE', whereParts.join(' AND ')].join(' ') : '',
        'ORDER BY articles.publishedAt DESC, articles.id DESC',
        'LIMIT ? OFFSET ?',
    ]
        .filter(Boolean)
        .join('\n');
    params.push(normalizedLimit, normalizedOffset);

    const rows = await all(sql, params);
    const mapped = rows.map(row => ({ ...mapArticleRow(row), bullshit: Boolean(row.bullshit) }));

    const articleIds = mapped
        .map(article => Number(article.id))
        .filter(articleId => Number.isInteger(articleId) && articleId > 0);
    const [topicsByArticleId, bullshitMatchesByArticleId] = await Promise.all([
        includeTopics ? loadTopicsByArticleIds(articleIds, { all }) : Promise.resolve(new Map()),
        bullshitRulesAvailable ? loadBullshitMatchesByArticleIds(articleIds, { all }) : Promise.resolve(new Map()),
    ]);

    return mapped.map(article => ({
        ...article,
        ...(includeTopics ? { topics: topicsByArticleId.get(Number(article.id)) || [] } : {}),
        bullshitRules: (bullshitMatchesByArticleId.get(Number(article.id)) || []).map(rule => rule.name),
    }));
}
