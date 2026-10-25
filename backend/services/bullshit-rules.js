import { all, get, run, transaction } from '../database/datenbank.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { loadBullshitMatchesByArticleIds as readBullshitMatches } from './bullshit-reader.js';

export const BULLSHIT_RULE_FIELDS = Object.freeze(['title', 'teaser', 'url', 'source']);
export const BULLSHIT_RULE_OPERATORS = Object.freeze(['contains', 'not_contains', 'equals', 'regex']);

const RULE_CACHE_TTL_MS = 15 * 1000;
const REEVALUATION_BATCH_SIZE = 250;
const MAX_RULE_NAME_LENGTH = 200;
const MAX_RULE_VALUE_LENGTH = 500;

let activeRulesCache = { at: 0, rules: [] };

function normalizedText(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function cleanText(value, maxLength) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function assertSafeRegex(value) {
    if (value.length > MAX_RULE_VALUE_LENGTH) throw new Error(`Regex must not exceed ${MAX_RULE_VALUE_LENGTH} characters`);
    if (/\\[1-9]/u.test(value)) throw new Error('Regex backreferences are not supported');
    if (/\((?:[^()\\]|\\.)*(?:\*|\+|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:\*|\+|\{\d+(?:,\d*)?\})/u.test(value)) {
        throw new Error('Regex contains unsafe nested repetition');
    }
    try {
        return new RegExp(value, 'iu');
    } catch {
        throw new Error('Invalid regular expression');
    }
}

export function normalizeBullshitRule(input = {}, { existing = null } = {}) {
    const merged = existing ? { ...existing, ...input } : input;
    const name = cleanText(merged.name, MAX_RULE_NAME_LENGTH);
    const field = String(merged.field || '').trim().toLowerCase();
    const operator = String(merged.operator || '').trim().toLowerCase();
    const value = String(merged.value || '').trim().slice(0, MAX_RULE_VALUE_LENGTH);
    const enabled = merged.enabled === undefined ? true : Boolean(merged.enabled);

    if (!name) throw new Error('Rule name is required');
    if (!BULLSHIT_RULE_FIELDS.includes(field)) throw new Error('Invalid rule field');
    if (!BULLSHIT_RULE_OPERATORS.includes(operator)) throw new Error('Invalid rule operator');
    if (!value) throw new Error('Rule value is required');
    if (operator === 'regex') assertSafeRegex(value);
    return { name, enabled, field, operator, value };
}

function rowToRule(row) {
    return {
        id: Number(row.id),
        name: row.name,
        enabled: Boolean(row.enabled),
        field: row.field,
        operator: row.operator,
        value: row.value,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function compileRule(rule) {
    if (rule.operator !== 'regex') return rule;
    try {
        return { ...rule, regex: assertSafeRegex(rule.value) };
    } catch (error) {
        logWarn('Skipping invalid bullshit regex rule', { ruleId: rule.id, error: error.message });
        return null;
    }
}

function invalidateRuleCache() {
    activeRulesCache = { at: 0, rules: [] };
}

export async function getBullshitRules() {
    return (await all('SELECT * FROM bullshit_rules ORDER BY id DESC')).map(rowToRule);
}

export async function getBullshitRule(id) {
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) return null;
    const row = await get('SELECT * FROM bullshit_rules WHERE id = ?', [ruleId]);
    return row ? rowToRule(row) : null;
}

export async function getActiveBullshitRules({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - activeRulesCache.at <= RULE_CACHE_TTL_MS) return activeRulesCache.rules;
    const rows = await all('SELECT * FROM bullshit_rules WHERE enabled = 1 ORDER BY id ASC');
    const rules = rows.map(rowToRule).map(compileRule).filter(Boolean);
    activeRulesCache = { at: now, rules };
    return rules;
}

function articleField(article, field) {
    if (field === 'source') return article?.sourceName || article?.source || '';
    return article?.[field] || '';
}

export function ruleMatchesArticle(rule, article) {
    if (!rule?.enabled) return false;
    const rawValue = String(articleField(article, rule.field));
    const articleValue = normalizedText(rawValue);
    const ruleValue = normalizedText(rule.value);
    if (rule.operator === 'contains') return articleValue.includes(ruleValue);
    if (rule.operator === 'not_contains') return !articleValue.includes(ruleValue);
    if (rule.operator === 'equals') return articleValue === ruleValue;
    if (rule.operator === 'regex') {
        try {
            const regex = rule.regex || assertSafeRegex(String(rule.value || ''));
            regex.lastIndex = 0;
            return regex.test(rawValue);
        } catch (error) {
            logWarn('Bullshit regex evaluation failed', { ruleId: rule.id, error: error.message });
            return false;
        }
    }
    return false;
}

export function evaluateArticleAgainstRules(article, rules) {
    return (Array.isArray(rules) ? rules : []).filter(rule => ruleMatchesArticle(rule, article));
}

async function loadArticleForEvaluation(articleId) {
    return get(
        `SELECT articles.id, articles.title, articles.teaser, articles.url,
                COALESCE(NULLIF(feeds.name, ''), sources.name) AS sourceName
         FROM articles
         JOIN feeds ON feeds.id = articles.feedId
         JOIN sources ON sources.id = feeds.sourceId
         WHERE articles.id = ?`,
        [articleId],
    );
}

async function replaceMatches(articleId, matchedRules, database = { run, transaction }) {
    await database.transaction(async () => {
        await database.run('DELETE FROM article_bullshit_matches WHERE articleId = ?', [articleId]);
        for (const rule of matchedRules) {
            await database.run(
                `INSERT INTO article_bullshit_matches (articleId, ruleId, matchedAt)
                 VALUES (?, ?, datetime('now'))`,
                [articleId, rule.id],
            );
        }
    });
}

export async function evaluateAndPersistArticleBullshit(article, { rules = null } = {}) {
    const articleId = Number(article?.id || article?.articleId);
    if (!Number.isInteger(articleId) || articleId <= 0) throw new Error('A valid article id is required');
    const resolvedArticle = article?.sourceName ? article : await loadArticleForEvaluation(articleId);
    if (!resolvedArticle) throw new Error('Article not found');
    const resolvedRules = rules || await getActiveBullshitRules();
    const matches = evaluateArticleAgainstRules(resolvedArticle, resolvedRules);
    await replaceMatches(articleId, matches);
    return matches.map(rule => ({ id: rule.id, name: rule.name }));
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

export async function reevaluateAllArticles() {
    const rules = await getActiveBullshitRules({ force: true });
    const counters = { processed: 0, matchedArticles: 0, ruleMatches: 0, failed: 0 };
    const matchedRuleIds = new Set();
    let lastArticleId = 0;

    while (true) {
        const articles = await all(
            `SELECT articles.id, articles.title, articles.teaser, articles.url,
                    COALESCE(NULLIF(feeds.name, ''), sources.name) AS sourceName
             FROM articles
             JOIN feeds ON feeds.id = articles.feedId
             JOIN sources ON sources.id = feeds.sourceId
             WHERE articles.id > ?
             ORDER BY articles.id ASC
             LIMIT ?`,
            [lastArticleId, REEVALUATION_BATCH_SIZE],
        );
        if (!articles.length) break;

        const matchesByArticle = articles.map(article => ({
            article,
            matches: evaluateArticleAgainstRules(article, rules),
        }));
        await transaction(async () => {
            const ids = articles.map(article => Number(article.id));
            await run('DELETE FROM article_bullshit_matches WHERE articleId IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]);
            for (const { article, matches } of matchesByArticle) {
                for (const rule of matches) {
                    await run(
                        `INSERT INTO article_bullshit_matches (articleId, ruleId, matchedAt)
                         VALUES (?, ?, datetime('now'))`,
                        [article.id, rule.id],
                    );
                }
            }
        });

        for (const { matches } of matchesByArticle) {
            if (matches.length) counters.matchedArticles += 1;
            counters.ruleMatches += matches.length;
            matches.forEach(rule => matchedRuleIds.add(rule.id));
        }
        counters.processed += articles.length;
        lastArticleId = Number(articles.at(-1).id);
        await yieldToEventLoop();
    }

    const result = { ...counters, matchedRules: matchedRuleIds.size, activeRules: rules.length };
    logInfo('Bullshit rules re-evaluation complete', result);
    return result;
}

export async function createBullshitRule(input) {
    const rule = normalizeBullshitRule(input);
    const result = await run(
        `INSERT INTO bullshit_rules (name, enabled, field, operator, value, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [rule.name, rule.enabled ? 1 : 0, rule.field, rule.operator, rule.value],
    );
    invalidateRuleCache();
    return getBullshitRule(result.lastID);
}

export async function updateBullshitRule(id, input) {
    const existing = await getBullshitRule(id);
    if (!existing) return null;
    const rule = normalizeBullshitRule(input, { existing });
    await run(
        `UPDATE bullshit_rules
         SET name = ?, enabled = ?, field = ?, operator = ?, value = ?, updatedAt = datetime('now')
         WHERE id = ?`,
        [rule.name, rule.enabled ? 1 : 0, rule.field, rule.operator, rule.value, existing.id],
    );
    invalidateRuleCache();
    return getBullshitRule(existing.id);
}

export async function deleteBullshitRule(id) {
    const ruleId = Number(id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) return false;
    const result = await run('DELETE FROM bullshit_rules WHERE id = ?', [ruleId]);
    if (result.changes) invalidateRuleCache();
    return result.changes > 0;
}

export async function loadBullshitMatchesByArticleIds(articleIds, database = { all }) {
    return readBullshitMatches(articleIds, database);
}

