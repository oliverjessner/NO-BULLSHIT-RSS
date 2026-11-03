import { randomInt } from 'node:crypto';
import { readStoredDigestPayload } from '../../backend/services/digest-reader.js';
import { readTopArticles } from '../../backend/services/top-articles-reader.js';

const RANDOM_ARTICLE_WINDOW = 50;

function parseTopic(row) {
    let config = {};
    try {
        config = JSON.parse(row.configJson || '{}');
    } catch {
        config = {};
    }

    return {
        id: Number(row.id),
        slug: row.slug,
        label: row.label,
        type: config.type ?? null,
        minMatches: Number(config.minMatches || 1),
        exclude: Array.isArray(config.exclude) ? config.exclude : [],
        strong: Array.isArray(config.strong) ? config.strong : [],
        medium: Array.isArray(config.medium) ? config.medium : [],
        weak: Array.isArray(config.weak) ? config.weak : [],
        ruleVersion: Number(row.ruleVersion),
    };
}

export async function readStoredTopics(database) {
    const rows = await database.all(
        'SELECT id, slug, label, configJson, ruleVersion FROM topics ORDER BY slug ASC',
    );
    return rows.map(parseTopic);
}

export async function readStoredLists(database) {
    const rows = await database.all(
        `SELECT lists.id, lists.name, lists.description, lists.color,
                COUNT(list_items.articleId) AS articleCount
         FROM lists
         LEFT JOIN list_items ON list_items.listId = lists.id
         GROUP BY lists.id
         ORDER BY lists.id ASC`,
    );
    return rows.map(row => ({ ...row, id: Number(row.id), articleCount: Number(row.articleCount) }));
}

async function readNewestStoredArticles(database) {
    const sourceNameExpression = database.feedNamesAvailable === false
        ? 'sources.name'
        : "COALESCE(NULLIF(feeds.name, ''), sources.name)";
    const sql = [
        'SELECT articles.id, articles.title, articles.url, articles.publishedAt,',
        sourceNameExpression,
        'AS sourceName',
        'FROM articles',
        'JOIN feeds ON feeds.id = articles.feedId',
        'JOIN sources ON sources.id = feeds.sourceId',
        'ORDER BY articles.publishedAt DESC, articles.id DESC',
        'LIMIT ?',
    ].join(' ');

    return database.all(sql, [RANDOM_ARTICLE_WINDOW]);
}

function publicationTime(article) {
    const value = article.publishedAt;
    const normalized = typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
        ? `${value.replace(' ', 'T')}Z` : value;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

export async function readRandomStoredArticle(database, { source = 'feed', randomIndex = randomInt } = {}) {
    let candidates;
    if (source === 'digest') {
        const payload = await readStoredDigestPayload('day', database);
        const articles = new Map();
        for (const cluster of payload.clusters) {
            for (const article of cluster.items) articles.set(article.id, article);
        }
        candidates = [...articles.values()]
            .sort((left, right) => publicationTime(right) - publicationTime(left) || right.id - left.id)
            .slice(0, RANDOM_ARTICLE_WINDOW);
    } else if (source === 'top') {
        const payload = await readTopArticles(database, { limit: RANDOM_ARTICLE_WINDOW, includeContent: false });
        candidates = payload.items;
    } else if (source === 'feed') {
        candidates = await readNewestStoredArticles(database);
    } else {
        throw new Error(`Unknown random article source: ${source}`);
    }
    return candidates.length ? candidates[randomIndex(candidates.length)] : null;
}

export async function readStoredListArticles(database, listName) {
    const lists = await database.all(
        'SELECT id, name FROM lists WHERE name = ? COLLATE NOCASE ORDER BY id ASC',
        [listName],
    );
    if (lists.length === 0) throw new Error(`List not found: ${listName}`);
    if (lists.length > 1) throw new Error(`Multiple lists named "${listName}" found.`);

    const sourceNameExpression = database.feedNamesAvailable === false
        ? 'sources.name'
        : "COALESCE(NULLIF(feeds.name, ''), sources.name)";
    const selectSql = [
        `SELECT articles.id, articles.title, articles.url, articles.publishedAt,`,
        sourceNameExpression,
        `AS sourceName
         FROM list_items
         JOIN articles ON articles.id = list_items.articleId
         JOIN feeds ON feeds.id = articles.feedId
         JOIN sources ON sources.id = feeds.sourceId
         WHERE list_items.listId = ?
         ORDER BY articles.publishedAt DESC, articles.id DESC`,
    ].join('\n');
    return database.all(
        selectSql,
        [lists[0].id],
    );
}
