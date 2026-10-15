import { Engine } from 'json-rules-engine';
import crypto from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, transaction } from '../database/datenbank.js';
import { logInfo, logWarn } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveTopicRulesFilePath() {
    const envPath = normalizeWhitespace(process.env.TOPIC_RULES_FILE_PATH || '');
    if (envPath) {
        return path.resolve(envPath);
    }

    const dbPath = normalizeWhitespace(process.env.DB_PATH || '');
    if (dbPath) {
        return path.join(path.dirname(path.resolve(dbPath)), 'topics.rules.json');
    }

    const projectPath = path.join(__dirname, '..', '..', 'topics.rules.json');
    if (!projectPath.includes('.asar')) {
        return projectPath;
    }

    return path.resolve(process.cwd(), 'topics.rules.json');
}

const TOPIC_RULES_FILE_PATH = resolveTopicRulesFilePath();

const TOPIC_KEYWORD_GROUPS = Object.freeze(['strong', 'medium', 'weak']);
const TOPIC_SCORE_WEIGHTS = Object.freeze({ strong: 5, medium: 3, weak: 1 });
const TOPIC_FIELD_MULTIPLIERS = Object.freeze({ title: 2, teaser: 1.5, body: 1 });

const TOPIC_SCORE_ASSIGN_THRESHOLD = 6;
const TOPIC_SCORE_LOW_CONFIDENCE_THRESHOLD = 3;

const TOPIC_CACHE_TTL_MS = 15 * 1000;

const DEFAULT_TOPIC_RULES = {
    ki: {
        label: 'KI',
        strong: ['künstliche intelligenz', 'artificial intelligence', 'chatgpt', 'openai', 'claude', 'llm', 'generative ai'],
        medium: ['copilot', 'prompting', 'gemini', 'anthropic', 'embedding'],
        weak: ['modell', 'inferenz', 'fine tuning'],
    },
    startup: {
        label: 'Startup',
        strong: ['startup', 'venture capital', 'seed-runde', 'series a', 'cap table'],
        medium: ['founder', 'gründung', 'runway', 'pitch deck', 'business angel'],
        weak: ['investment', 'finanzierung'],
    },
};

let topicDefinitionsCache = {
    at: 0,
    definitions: [],
};

let engineCache = {
    signature: '',
    engine: null,
};

function toStableJson(value) {
    return JSON.stringify(value, null, 2);
}

function hashValue(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function slugToLabel(slug) {
    return String(slug || '')
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
        .trim();
}

function normalizeWhitespace(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ');
}

export function normalizeTopicSlug(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function normalizeKeywordToken(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeKeywordList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set();
    const normalized = [];

    value.forEach(entry => {
        const cleaned = normalizeWhitespace(entry);
        if (!cleaned) {
            return;
        }
        const canonical = normalizeKeywordToken(cleaned);
        if (!canonical || seen.has(canonical)) {
            return;
        }
        seen.add(canonical);
        normalized.push(cleaned);
    });

    return normalized;
}

function normalizeTopicType(value) {
    const normalized = normalizeWhitespace(value).toLowerCase();
    return normalized || null;
}

function normalizeMinMatches(value) {
    if (value === undefined || value === null || value === '') {
        return 1;
    }

    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < 1) {
        throw new Error('Topic minMatches must be an integer greater than or equal to 1');
    }

    return normalized;
}

function normalizeTopicDefinition(slug, rawTopic = {}) {
    const normalizedSlug = normalizeTopicSlug(slug);
    if (!normalizedSlug) {
        throw new Error('Topic slug is required and must contain only a-z, 0-9, -, _');
    }

    const label = normalizeWhitespace(rawTopic.label || slugToLabel(normalizedSlug) || normalizedSlug);
    if (!label) {
        throw new Error(['Topic "', normalizedSlug, '" needs a label'].join(''));
    }

    const topic = {
        slug: normalizedSlug,
        label,
        type: normalizeTopicType(rawTopic.type),
        minMatches: normalizeMinMatches(rawTopic.minMatches),
        exclude: normalizeKeywordList(rawTopic.exclude),
        strong: normalizeKeywordList(rawTopic.strong),
        medium: normalizeKeywordList(rawTopic.medium),
        weak: normalizeKeywordList(rawTopic.weak),
    };

    const keywordCount = topic.strong.length + topic.medium.length + topic.weak.length;
    if (keywordCount === 0) {
        throw new Error(['Topic "', normalizedSlug, '" needs at least one keyword'].join(''));
    }

    return topic;
}

function parseObjectTopicMap(input) {
    const entries = Object.entries(input || {});
    if (entries.length === 0) {
        return [];
    }

    return entries.map(([slug, value]) => normalizeTopicDefinition(slug, value));
}

function parseArrayTopicList(input) {
    if (!Array.isArray(input)) {
        return [];
    }

    return input.map(item => normalizeTopicDefinition(item?.slug, item));
}

export function validateAndNormalizeTopicDefinitions(input) {
    const rawTopics = Array.isArray(input) ? parseArrayTopicList(input) : parseObjectTopicMap(input);
    const seen = new Set();

    const normalized = rawTopics.map(topic => {
        if (seen.has(topic.slug)) {
            throw new Error(['Duplicate topic slug: ', topic.slug].join(''));
        }
        seen.add(topic.slug);
        return topic;
    });

    return normalized.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function definitionsToRulesObject(definitions) {
    return definitions.reduce((acc, topic) => {
        acc[topic.slug] = {
            label: topic.label,
            ...(topic.type ? { type: topic.type } : {}),
            ...(topic.minMatches !== 1 ? { minMatches: topic.minMatches } : {}),
            strong: topic.strong,
            medium: topic.medium,
            weak: topic.weak,
            ...(topic.exclude.length > 0 ? { exclude: topic.exclude } : {}),
        };
        return acc;
    }, {});
}

function topicDefinitionToConfig(topic) {
    return {
        type: topic.type,
        minMatches: topic.minMatches,
        exclude: topic.exclude,
        strong: topic.strong,
        medium: topic.medium,
        weak: topic.weak,
    };
}

async function ensureTopicsRulesFileExists() {
    await mkdir(path.dirname(TOPIC_RULES_FILE_PATH), { recursive: true });
    try {
        await access(TOPIC_RULES_FILE_PATH);
    } catch {
        await writeFile(TOPIC_RULES_FILE_PATH, toStableJson(DEFAULT_TOPIC_RULES) + '\n', 'utf-8');
    }
}

async function readTopicRulesFile() {
    await ensureTopicsRulesFileExists();
    const raw = await readFile(TOPIC_RULES_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
        raw,
        definitions: validateAndNormalizeTopicDefinitions(parsed),
    };
}

async function writeTopicRulesFile(definitions) {
    const nextRaw = toStableJson(definitionsToRulesObject(definitions));
    await writeFile(TOPIC_RULES_FILE_PATH, [nextRaw, '\n'].join(''), 'utf-8');
    return nextRaw;
}

function parseTopicRow(row) {
    let config = {};
    try {
        config = JSON.parse(row.configJson || '{}');
    } catch {
        config = {};
    }

    return normalizeTopicDefinition(row.slug, {
        label: row.label,
        type: config.type,
        minMatches: config.minMatches,
        exclude: config.exclude,
        strong: config.strong,
        medium: config.medium,
        weak: config.weak,
    });
}

async function getTopicDefinitionsFromDatabase() {
    const rows = await all('SELECT id, slug, label, configJson, createdAt, updatedAt FROM topics ORDER BY slug ASC');
    const definitions = [];
    rows.forEach(row => {
        try {
            definitions.push(parseTopicRow(row));
        } catch (err) {
            logWarn('Skipping invalid topic row', { slug: row.slug, error: err.message });
        }
    });
    return definitions;
}

function invalidateTopicCaches() {
    topicDefinitionsCache = { at: 0, definitions: [] };
    engineCache = { signature: '', engine: null };
}

async function saveTopicDefinitionsToDatabase(definitions) {
    const normalized = validateAndNormalizeTopicDefinitions(definitions);
    const slugs = normalized.map(topic => topic.slug);
    const classificationVersion = hashValue(definitionsToRulesObject(normalized));

    await transaction(async () => {
        for (const topic of normalized) {
            const configJson = JSON.stringify(topicDefinitionToConfig(topic));
            const ruleHash = hashValue({ slug: topic.slug, label: topic.label, configJson });

            await run(
                [
                    'INSERT INTO topics (slug, label, configJson, ruleHash, ruleVersion, createdAt, updatedAt)',
                    'VALUES (?, ?, ?, ?, 1, datetime(\'now\'), datetime(\'now\'))',
                    'ON CONFLICT(slug) DO UPDATE SET',
                    'label = excluded.label,',
                    'configJson = excluded.configJson,',
                    'ruleVersion = CASE WHEN topics.ruleHash <> excluded.ruleHash THEN topics.ruleVersion + 1 ELSE topics.ruleVersion END,',
                    'ruleHash = excluded.ruleHash,',
                    'updatedAt = datetime(\'now\')',
                ].join('\n'),
                [topic.slug, topic.label, configJson, ruleHash],
            );
        }

        if (slugs.length > 0) {
            await run('DELETE FROM topics WHERE slug NOT IN (SELECT value FROM json_each(?))', [
                JSON.stringify(slugs),
            ]);
        } else {
            await run('DELETE FROM topics');
        }
        await run(
            [
                "INSERT INTO app_metadata (key, value, updatedAt) VALUES ('topicRulesVersion', ?, datetime('now'))",
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
            ].join(' '),
            [classificationVersion],
        );
        await run(
            [
                "UPDATE articles SET classificationStatus = 'pending', updatedAt = datetime('now')",
                'WHERE classificationVersion IS NULL OR classificationVersion <> ?',
            ].join(' '),
            [classificationVersion],
        );
        await run("UPDATE digest_periods SET dirtyAt = datetime('now'), rulesVersion = ?, updatedAt = datetime('now') WHERE status <> 'closed'", [
            classificationVersion,
        ]);
    });

    invalidateTopicCaches();
    return normalized;
}

export async function ensureTopicDefinitionsInitialized() {
    const existing = await get('SELECT id FROM topics LIMIT 1');
    if (existing) return getTopicDefinitions({ force: true });
    try {
        const { definitions } = await readTopicRulesFile();
        await saveTopicDefinitionsToDatabase(definitions);
        return definitions;
    } catch (err) {
        logWarn('Invalid topic rules file. Restoring defaults.', {
            path: TOPIC_RULES_FILE_PATH,
            error: err.message,
        });
        await writeFile(TOPIC_RULES_FILE_PATH, [toStableJson(DEFAULT_TOPIC_RULES), '\n'].join(''), 'utf-8');
        const fallbackDefinitions = validateAndNormalizeTopicDefinitions(DEFAULT_TOPIC_RULES);
        await saveTopicDefinitionsToDatabase(fallbackDefinitions);
        return fallbackDefinitions;
    }
}

export async function getTopicDefinitions({ force = false } = {}) {
    const now = Date.now();
    if (!force && topicDefinitionsCache.definitions.length > 0 && now - topicDefinitionsCache.at <= TOPIC_CACHE_TTL_MS) {
        return topicDefinitionsCache.definitions;
    }

    let definitions = await getTopicDefinitionsFromDatabase();
    if (definitions.length === 0) {
        definitions = await ensureTopicDefinitionsInitialized();
    }

    topicDefinitionsCache = {
        at: now,
        definitions,
    };

    return definitions;
}

export async function getTopicRowsWithMetadata() {
    const rows = await all('SELECT id, slug, label, configJson, createdAt, updatedAt FROM topics ORDER BY slug ASC');
    const normalizedRows = [];
    rows.forEach(row => {
        try {
            const parsed = parseTopicRow(row);
            normalizedRows.push({
                id: Number(row.id),
                slug: parsed.slug,
                label: parsed.label,
                type: parsed.type,
                minMatches: parsed.minMatches,
                exclude: parsed.exclude,
                strong: parsed.strong,
                medium: parsed.medium,
                weak: parsed.weak,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            });
        } catch (err) {
            logWarn('Skipping invalid topic row in metadata query', { slug: row.slug, error: err.message });
        }
    });
    return normalizedRows;
}

export async function getTopicRulesPayload() {
    const definitions = await getTopicDefinitions({ force: true });
    const raw = [toStableJson(definitionsToRulesObject(definitions)), '\n'].join('');
    return {
        path: TOPIC_RULES_FILE_PATH,
        raw,
        rules: definitionsToRulesObject(definitions),
        topics: definitions,
    };
}

export async function saveTopicsFromJsonInput(jsonInput) {
    const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
    const normalized = validateAndNormalizeTopicDefinitions(parsed);
    await saveTopicDefinitionsToDatabase(normalized);
    const raw = [toStableJson(definitionsToRulesObject(normalized)), '\n'].join('');

    return {
        raw,
        rules: definitionsToRulesObject(normalized),
        topics: normalized,
    };
}

export async function saveTopicsFromDefinitions(definitions) {
    const normalized = validateAndNormalizeTopicDefinitions(definitions);
    await saveTopicDefinitionsToDatabase(normalized);
    return normalized;
}

export async function getActiveTopicRulesVersion() {
    const row = await get("SELECT value FROM app_metadata WHERE key = 'topicRulesVersion'");
    if (row?.value) return row.value;
    const definitions = await getTopicDefinitions({ force: true });
    return hashValue(definitionsToRulesObject(definitions));
}

function stripHtml(value) {
    return String(value || '').replace(/<[^>]*>/g, ' ');
}

function normalizeDocumentScope(value) {
    const normalized = normalizeKeywordToken(stripHtml(value));
    return {
        text: normalized,
        tokenSet: new Set(normalized.split(' ').filter(Boolean)),
    };
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatchesScope(keyword, scope) {
    const normalizedKeyword = normalizeKeywordToken(keyword);
    if (!normalizedKeyword) {
        return false;
    }

    if (normalizedKeyword.includes(' ')) {
        if (!scope.text) {
            return false;
        }
        const pattern = normalizedKeyword
            .split(' ')
            .map(part => escapeRegex(part))
            .join('\\s+');
        const phraseRegex = new RegExp(['(^|\\s)', pattern, '(?=\\s|$)'].join(''), 'u');
        return phraseRegex.test(scope.text);
    }

    return scope.tokenSet.has(normalizedKeyword);
}

function roundScore(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function findTermLocations(term, scopes, baseWeight = 0) {
    const locations = [];

    Object.entries(TOPIC_FIELD_MULTIPLIERS).forEach(([field, multiplier]) => {
        const scope = scopes[field];
        if (!scope || !keywordMatchesScope(term, scope)) {
            return;
        }

        locations.push({
            field,
            ...(baseWeight > 0 ? { points: roundScore(baseWeight * multiplier) } : {}),
        });
    });

    return locations;
}

function scoreTopic(topicDefinition, scopes) {
    const matchesByCanonicalTerm = new Map();

    TOPIC_KEYWORD_GROUPS.forEach(group => {
        const terms = Array.isArray(topicDefinition[group]) ? topicDefinition[group] : [];
        const baseWeight = TOPIC_SCORE_WEIGHTS[group] || 0;

        terms.forEach(term => {
            const canonical = normalizeKeywordToken(term);
            const locations = findTermLocations(term, scopes, baseWeight);
            if (locations.length === 0) {
                return;
            }

            const contribution = Math.max(...locations.map(location => location.points));
            const current = matchesByCanonicalTerm.get(canonical);
            if (!current || contribution > current.contribution) {
                matchesByCanonicalTerm.set(canonical, {
                    term,
                    group,
                    baseWeight,
                    contribution,
                    locations,
                });
            }
        });
    });

    const matchedTerms = Array.from(matchesByCanonicalTerm.values());
    const score = matchedTerms.reduce((sum, match) => sum + match.contribution, 0);
    const excludedTerms = topicDefinition.exclude
        .map(term => ({ term, locations: findTermLocations(term, scopes) }))
        .filter(match => match.locations.length > 0);

    return {
        score: roundScore(score),
        distinctMatches: matchedTerms.length,
        matchedTerms,
        excluded: excludedTerms.length > 0,
        excludedTerms,
    };
}

function buildEngineCacheSignature(definitions) {
    return JSON.stringify(
        definitions.map(definition => ({
            slug: definition.slug,
            label: definition.label,
            minMatches: definition.minMatches,
        })),
    );
}

function toJsonPathKey(slug) {
    return ['$["', String(slug).replace(/"/g, '\\"'), '"]'].join('');
}

function buildThresholdEngine(definitions) {
    const engine = new Engine([], { allowUndefinedFacts: true });

    definitions.forEach(definition => {
        const topicPath = toJsonPathKey(definition.slug);

        engine.addRule({
            name: ['assign-', definition.slug].join(''),
            conditions: {
                all: [
                    {
                        fact: 'topicMetrics',
                        path: [topicPath, '.score'].join(''),
                        operator: 'greaterThanInclusive',
                        value: TOPIC_SCORE_ASSIGN_THRESHOLD,
                    },
                    {
                        fact: 'topicMetrics',
                        path: [topicPath, '.distinctMatches'].join(''),
                        operator: 'greaterThanInclusive',
                        value: definition.minMatches,
                    },
                    { fact: 'topicMetrics', path: [topicPath, '.excluded'].join(''), operator: 'equal', value: false },
                ],
            },
            event: {
                type: 'topic.assign',
                params: { topicSlug: definition.slug },
            },
        });

        engine.addRule({
            name: ['low-', definition.slug].join(''),
            conditions: {
                all: [
                    {
                        fact: 'topicMetrics',
                        path: [topicPath, '.score'].join(''),
                        operator: 'greaterThanInclusive',
                        value: TOPIC_SCORE_LOW_CONFIDENCE_THRESHOLD,
                    },
                    { fact: 'topicMetrics', path: [topicPath, '.excluded'].join(''), operator: 'equal', value: false },
                    {
                        any: [
                            {
                                fact: 'topicMetrics',
                                path: [topicPath, '.score'].join(''),
                                operator: 'lessThan',
                                value: TOPIC_SCORE_ASSIGN_THRESHOLD,
                            },
                            {
                                fact: 'topicMetrics',
                                path: [topicPath, '.distinctMatches'].join(''),
                                operator: 'lessThan',
                                value: definition.minMatches,
                            },
                        ],
                    },
                ],
            },
            event: {
                type: 'topic.lowConfidence',
                params: { topicSlug: definition.slug },
            },
        });
    });

    return engine;
}

function getThresholdEngine(definitions) {
    const signature = buildEngineCacheSignature(definitions);
    if (engineCache.signature === signature && engineCache.engine) {
        return engineCache.engine;
    }

    engineCache = {
        signature,
        engine: buildThresholdEngine(definitions),
    };

    return engineCache.engine;
}

async function evaluateTopicThresholds(definitions, topicMetrics) {
    const engine = getThresholdEngine(definitions);
    const { events } = await engine.run({ topicMetrics });

    const assigned = new Set();
    const lowConfidence = new Set();

    events.forEach(event => {
        const topicSlug = event?.params?.topicSlug;
        if (!topicSlug) {
            return;
        }
        if (event.type === 'topic.assign') {
            assigned.add(topicSlug);
            lowConfidence.delete(topicSlug);
            return;
        }
        if (event.type === 'topic.lowConfidence' && !assigned.has(topicSlug)) {
            lowConfidence.add(topicSlug);
        }
    });

    return { assigned, lowConfidence };
}

export async function classifyArticleTopicsFromDefinitions(article, definitionsInput) {
    const definitions = validateAndNormalizeTopicDefinitions(definitionsInput);
    if (definitions.length === 0) {
        return {
            assignedTopics: [],
            lowConfidenceTopics: [],
            scoredTopics: [],
        };
    }

    const scopes = {
        title: normalizeDocumentScope(article?.title || ''),
        teaser: normalizeDocumentScope(article?.teaser || article?.summary || ''),
        body: normalizeDocumentScope(article?.content || article?.body || ''),
    };

    const scoredTopics = definitions.map(definition => {
        const scored = scoreTopic(definition, scopes);
        return {
            slug: definition.slug,
            label: definition.label,
            type: definition.type,
            score: scored.score,
            distinctMatches: scored.distinctMatches,
            matchedTerms: scored.matchedTerms,
            excluded: scored.excluded,
            excludedTerms: scored.excludedTerms,
        };
    });

    const topicMetrics = scoredTopics.reduce((acc, topic) => {
        acc[topic.slug] = {
            score: topic.score,
            distinctMatches: topic.distinctMatches,
            excluded: topic.excluded,
        };
        return acc;
    }, {});

    const thresholdResult = await evaluateTopicThresholds(definitions, topicMetrics);

    const assignedTopics = scoredTopics
        .filter(topic => thresholdResult.assigned.has(topic.slug))
        .map(topic => ({
            ...topic,
            confidence: 'high',
        }));

    const lowConfidenceTopics = scoredTopics
        .filter(topic => thresholdResult.lowConfidence.has(topic.slug))
        .map(topic => ({
            ...topic,
            confidence: 'low',
        }));

    return {
        assignedTopics,
        lowConfidenceTopics,
        scoredTopics,
    };
}

export async function classifyArticleTopics(article, { definitions = null } = {}) {
    const resolvedDefinitions = definitions || (await getTopicDefinitions());
    return classifyArticleTopicsFromDefinitions(article, resolvedDefinitions);
}

export async function replaceArticleTopics(articleId, classification) {
    const normalizedArticleId = Number(articleId);
    if (!Number.isInteger(normalizedArticleId) || normalizedArticleId <= 0) {
        throw new Error('replaceArticleTopics requires a valid article id');
    }

    const classificationVersion = await getActiveTopicRulesVersion();

    const assignedTopics = Array.isArray(classification?.assignedTopics) ? classification.assignedTopics : [];
    await transaction(async () => {
        await run('DELETE FROM article_topics WHERE articleId = ?', [normalizedArticleId]);
        for (const topic of assignedTopics) {
            const topicRow = await get('SELECT id FROM topics WHERE slug = ?', [topic.slug]);
            if (!topicRow) continue;
            const matchedTermsJson = JSON.stringify({
                confidence: topic.confidence,
                terms: (topic.matchedTerms || []).map(match => match.term),
            });
            await run(
                [
                    'INSERT INTO article_topics (articleId, topicId, score, matchedTermsJson, classificationVersion, createdAt)',
                    "VALUES (?, ?, ?, ?, ?, datetime('now'))",
                ].join(' '),
                [normalizedArticleId, topicRow.id, topic.score, matchedTermsJson, classificationVersion],
            );
        }
        await run(
            "UPDATE articles SET classificationVersion = ?, classificationStatus = 'ready', updatedAt = datetime('now') WHERE id = ?",
            [classificationVersion, normalizedArticleId],
        );
    });
}

export async function classifyAndPersistArticleTopics(article) {
    const articleId = Number(article?.id || article?.articleId);
    if (!Number.isInteger(articleId) || articleId <= 0) {
        throw new Error('classifyAndPersistArticleTopics requires article.id or articleId');
    }

    const classification = await classifyArticleTopics(article);
    await replaceArticleTopics(articleId, classification);

    if (classification.assignedTopics.length > 0 || classification.lowConfidenceTopics.length > 0) {
        logInfo('Topic classification complete', {
            articleId,
            assigned: classification.assignedTopics.map(topic => ({ slug: topic.slug, score: topic.score })),
            lowConfidence: classification.lowConfidenceTopics.map(topic => ({ slug: topic.slug, score: topic.score })),
        });
    }

    return classification;
}

export async function getArticleTopics(articleId) {
    const normalizedArticleId = Number(articleId);
    if (!Number.isInteger(normalizedArticleId) || normalizedArticleId <= 0) {
        return [];
    }

    const rows = await all(
        [
            'SELECT article_topics.articleId,',
            'topics.slug AS topicSlug,',
            'article_topics.score,',
            'article_topics.matchedTermsJson,',
            'article_topics.createdAt,',
            'topics.label',
            'FROM article_topics',
            'JOIN topics ON topics.id = article_topics.topicId',
            'WHERE article_topics.articleId = ?',
            'ORDER BY article_topics.score DESC, topics.slug ASC',
        ].join('\n'),
        [normalizedArticleId],
    );

    return rows.map(row => {
        let matchedTerms = {};
        try {
            matchedTerms = JSON.parse(row.matchedTermsJson || '{}');
        } catch {
            matchedTerms = {};
        }
        return {
            articleId: Number(row.articleId),
            topicSlug: row.topicSlug,
            topicLabel: row.label,
            score: Number(row.score || 0),
            matchedTerms,
            createdAt: row.createdAt,
        };
    });
}

export async function reprocessTopicClassificationForAllArticles() {
    const definitions = await getTopicDefinitions({ force: true });
    const classificationVersion = await getActiveTopicRulesVersion();
    const staleCondition = "classificationStatus <> 'ready' OR classificationVersion IS NULL OR classificationVersion <> ?";
    const { count: totalToProcess } = await get(
        `SELECT COUNT(*) AS count FROM articles WHERE ${staleCondition}`,
        [classificationVersion],
    );

    const counters = {
        processed: 0,
        assignedArticles: 0,
        topicAssignments: 0,
        failed: 0,
    };
    let lastArticleId = 0;

    while (true) {
        const articles = await all(
            [
                'SELECT id, title, teaser, content FROM articles',
                `WHERE id > ? AND (${staleCondition})`,
                'ORDER BY id ASC LIMIT 250',
            ].join(' '),
            [lastArticleId, classificationVersion],
        );
        if (articles.length === 0) break;
        for (const article of articles) {
            lastArticleId = Number(article.id);
            try {
                const classification = await classifyArticleTopics(article, { definitions });
                const assignedTopics = classification.assignedTopics || [];

                if (assignedTopics.length > 0) counters.assignedArticles += 1;

                counters.topicAssignments += assignedTopics.length;
                await replaceArticleTopics(article.id, classification);
            } catch (error) {
                counters.failed += 1;
                await run("UPDATE articles SET classificationStatus = 'failed', updatedAt = datetime('now') WHERE id = ?", [article.id]);
                logWarn('Topic reprocess article failed', { articleId: article.id, error: error.message });
            }

            counters.processed += 1;
            if (counters.processed % 250 === 0) {
                logInfo('Topic reprocess progress', {
                    processed: counters.processed,
                    total: totalToProcess,
                });
            }
        }
    }

    logInfo('Topic reprocess complete', {
        processed: counters.processed,
        assignedArticles: counters.assignedArticles,
        topicAssignments: counters.topicAssignments,
    });

    return {
        ...counters,
        totalArticles: Number((await get('SELECT COUNT(*) AS count FROM articles'))?.count || 0),
        topicCount: definitions.length,
    };
}

export async function upsertTopic(topicInput, { existingSlug = null } = {}) {
    const current = await getTopicDefinitions({ force: true });
    const baseSlug = normalizeTopicSlug(existingSlug || topicInput?.slug);

    if (existingSlug && !current.some(topic => topic.slug === baseSlug)) {
        throw new Error(['Topic not found: ', existingSlug].join(''));
    }

    const nextTopic = normalizeTopicDefinition(topicInput?.slug || baseSlug, topicInput);
    const filtered = current.filter(topic => topic.slug !== baseSlug);

    if (filtered.some(topic => topic.slug === nextTopic.slug)) {
        throw new Error(['Topic slug already exists: ', nextTopic.slug].join(''));
    }

    const nextDefinitions = [...filtered, nextTopic];
    await saveTopicsFromDefinitions(nextDefinitions);

    return nextTopic;
}

export async function deleteTopicBySlug(slug) {
    const normalizedSlug = normalizeTopicSlug(slug);
    if (!normalizedSlug) {
        throw new Error('Invalid topic slug');
    }

    const current = await getTopicDefinitions({ force: true });
    if (!current.some(topic => topic.slug === normalizedSlug)) {
        return false;
    }

    const nextDefinitions = current.filter(topic => topic.slug !== normalizedSlug);
    await saveTopicsFromDefinitions(nextDefinitions);
    return true;
}

export async function getTopicBySlug(slug) {
    const normalizedSlug = normalizeTopicSlug(slug);
    if (!normalizedSlug) {
        return null;
    }

    const row = await get('SELECT id, slug, label, configJson, createdAt, updatedAt FROM topics WHERE slug = ?', [
        normalizedSlug,
    ]);

    if (!row) {
        return null;
    }

    const parsed = parseTopicRow(row);
    return {
        id: Number(row.id),
        slug: parsed.slug,
        label: parsed.label,
        type: parsed.type,
        minMatches: parsed.minMatches,
        exclude: parsed.exclude,
        strong: parsed.strong,
        medium: parsed.medium,
        weak: parsed.weak,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export function getTopicRulesFilePath() {
    return TOPIC_RULES_FILE_PATH;
}

export function getTopicScoringConfig() {
    return {
        weights: TOPIC_SCORE_WEIGHTS,
        fieldMultipliers: TOPIC_FIELD_MULTIPLIERS,
        thresholds: {
            assign: TOPIC_SCORE_ASSIGN_THRESHOLD,
            lowConfidence: TOPIC_SCORE_LOW_CONFIDENCE_THRESHOLD,
        },
    };
}
