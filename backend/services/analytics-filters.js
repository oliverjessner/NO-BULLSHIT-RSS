const DAY_MS = 86_400_000;
export const ANALYTICS_PERIODS = Object.freeze(['7d', '30d', '90d', 'all']);
export const ANALYTICS_RANKING_KEYS = Object.freeze(['most_read', 'most_commented', 'top_news']);
export const ANALYTICS_SORTS = Object.freeze(['name', 'title', 'sourceName', 'rankingKey', 'totalArticles', 'periodArticles', 'averagePerDay', 'bullshitArticles', 'bullshitRate', 'rankedArticles', 'bestRank', 'latestRank', 'firstCaptured', 'lastCaptured', 'snapshotAppearances']);

function invalid(message) {
    return Object.assign(new Error(message), { status: 400 });
}

function positiveId(value, name) {
    if (value == null || value === '' || value === 'all') return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw invalid(`Invalid ${name}.`);
    return number;
}

function list(value) {
    return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).filter(Boolean))];
}

export function normalizeAnalyticsFilters(input = {}, { now = new Date() } = {}) {
    const period = input.period || '30d';
    const group = input.group || 'day';
    const timeBasis = input.basis || input.timeBasis || 'publishedAt';
    const rankingKey = !input.rankingKey || input.rankingKey === 'all' ? null : input.rankingKey;
    if (!ANALYTICS_PERIODS.includes(period)) throw invalid('Invalid analytics period.');
    if (!['day', 'week', 'month'].includes(group)) throw invalid('Invalid analytics grouping.');
    if (!['publishedAt', 'fetchedAt'].includes(timeBasis)) throw invalid('Invalid analytics time basis.');
    if (rankingKey && !ANALYTICS_RANKING_KEYS.includes(rankingKey)) throw invalid('Invalid ranking type.');
    const end = new Date(input.endAt || now);
    if (!Number.isFinite(end.getTime())) throw invalid('Invalid analytics time.');
    const days = period === 'all' ? null : Number.parseInt(period, 10);
    const topic = input.topic || null;
    const topicSlugs = list(input.topics || input.topicSlugs);
    if ([topic, ...topicSlugs].filter(Boolean).some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value)) || topicSlugs.length > 8) throw invalid('Invalid analytics topic selection.');
    const compareIds = list(input.compare || input.compareIds).map(value => positiveId(value, 'comparison publisher'));
    if (compareIds.length > 2 || compareIds.some(value => value === null)) throw invalid('Choose at most two comparison publishers.');
    const limit = Number(input.limit ?? 100);
    const offset = Number(input.offset ?? 0);
    const historyLimit = Number(input.historyLimit ?? 1000);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000
        || !Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 1000) throw invalid('Invalid analytics pagination.');
    const sort = input.sort || 'periodArticles';
    const direction = input.direction || 'desc';
    if (!ANALYTICS_SORTS.includes(sort) || !['asc', 'desc'].includes(direction)) throw invalid('Invalid analytics sorting.');
    const sourceId = positiveId(input.sourceId, 'ranking publisher');
    const publisherId = positiveId(input.publisher ?? input.publisherId, 'publisher');
    let url = input.url || null;
    if (url) {
        try {
            const parsed = new URL(url);
            if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 4096) throw invalid('Invalid ranking article URL.');
            parsed.hash = '';
            url = parsed.toString();
        } catch { throw invalid('Invalid ranking article URL.'); }
    }
    return {
        period, startAt: days === null ? null : new Date(end.getTime() - days * DAY_MS).toISOString(),
        endAt: end.toISOString(), previousStartAt: days === null ? null : new Date(end.getTime() - 2 * days * DAY_MS).toISOString(),
        days, publisherId, topic, group, timeBasis, rankingKey, compareIds, topicSlugs, sort, direction, limit, offset, historyLimit, sourceId, url,
    };
}

// Identifiers come exclusively from our code; every user value stays a bound parameter.
export function articleScope(options, { alias = 'a', period = true, publisher = true, topic = true } = {}) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(alias)) throw new TypeError('Invalid article alias');
    const conditions = [];
    const params = [];
    if (period) {
        const basis = options.timeBasis === 'fetchedAt' ? 'fetchedAt' : 'publishedAt';
        if (options.startAt) { conditions.push(`julianday(${alias}.${basis}) >= julianday(?)`); params.push(options.startAt); }
        conditions.push(`julianday(${alias}.${basis}) < julianday(?)`); params.push(options.endAt);
    }
    if (publisher && options.publisherId) {
        conditions.push(`EXISTS (SELECT 1 FROM feeds analytics_feed WHERE analytics_feed.id = ${alias}.feedId AND analytics_feed.sourceId = ?)`);
        params.push(options.publisherId);
    }
    if (topic && options.topic) {
        conditions.push(`EXISTS (SELECT 1 FROM article_topics analytics_at JOIN topics analytics_topic ON analytics_topic.id = analytics_at.topicId WHERE analytics_at.articleId = ${alias}.id AND analytics_topic.slug = ?)`);
        params.push(options.topic);
    }
    return { where: conditions.join(' AND ') || '1', params };
}

export function analyticsBucket(column, group = 'day') {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.(?:publishedAt|fetchedAt|capturedAt)$/u.test(column)) throw new TypeError('Invalid analytics date column');
    if (group === 'month') return `strftime('%Y-%m-01', ${column})`;
    if (group === 'week') return `date(${column}, '-' || ((CAST(strftime('%w', ${column}) AS INTEGER) + 6) % 7) || ' days')`;
    return `date(${column})`;
}
