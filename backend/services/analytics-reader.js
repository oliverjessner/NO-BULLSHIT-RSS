import { normalizeAnalyticsFilters, articleScope } from './analytics-filters.js';
import { RANKING_MEDIA, rankingMediumForSource } from './ranking-media.js';

const ROW_LIMIT = 100;
const POINT_LIMIT = 512;
const SERIES_LIMIT = 10;
const asArray = value => typeof value === 'string' ? JSON.parse(value || '[]') : value || [];
const percent = (count, total) => total ? Number((100 * count / total).toFixed(2)) : null;
const filtersFor = options => normalizeAnalyticsFilters(options || {});
const jsonRows = sql => `(SELECT COALESCE(json_group_array(json_object(${sql.fields})), '[]') FROM (${sql.query}))`;
const coverage = (rows, total = rows.length) => ({ returned: rows.length, total: Number(total), truncated: Number(total) > rows.length });
const names = `COALESCE(NULLIF(f.name, ''), s.name)`;
const articleKey = alias => `COALESCE(NULLIF(TRIM(${alias}.canonicalUrl), ''), NULLIF(TRIM(${alias}.url), ''), 'article:' || ${alias}.id)`;

function bucketFor(options, alias = 'a') {
    const field = `${alias}.${options.timeBasis === 'fetchedAt' ? 'fetchedAt' : 'publishedAt'}`;
    if (options.group === 'month') return `strftime('%Y-%m-01', ${field})`;
    if (options.group === 'week') return `date(${field}, '-6 days', 'weekday 1')`;
    return `date(${field})`;
}

// Counts are aggregated by SQLite; only bounded calendar gaps are filled here.
function filledVolume(points, options, { observedTotal = points.length, firstBucket = points[0]?.bucket } = {}) {
    if (!points.length) return { points: [], coverage: { ...coverage([], 0), observedBuckets: Number(observedTotal) } };
    const floor = value => {
        const date = new Date(value);
        date.setUTCHours(0, 0, 0, 0);
        if (options.group === 'month') date.setUTCDate(1);
        else if (options.group === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
        return date;
    };
    const start = floor(options.startAt || firstBucket);
    const end = floor(options.startAt ? new Date(Date.parse(options.endAt) - 1) : points.at(-1).bucket);
    const total = options.group === 'month'
        ? (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1
        : Math.round((end - start) / (options.group === 'week' ? 604_800_000 : 86_400_000)) + 1;
    const cursor = new Date(end);
    if (options.group === 'month') cursor.setUTCMonth(cursor.getUTCMonth() - Math.min(total, POINT_LIMIT) + 1);
    else cursor.setUTCDate(cursor.getUTCDate() - (Math.min(total, POINT_LIMIT) - 1) * (options.group === 'week' ? 7 : 1));
    const values = new Map(points.map(point => [point.bucket, point.count]));
    const result = [];
    while (cursor <= end && result.length < POINT_LIMIT) {
        const bucket = cursor.toISOString().slice(0, 10);
        result.push({ bucket, count: values.get(bucket) || 0 });
        if (options.group === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        else cursor.setUTCDate(cursor.getUTCDate() + (options.group === 'week' ? 7 : 1));
    }
    return { points: result, coverage: { ...coverage(result, total), observedBuckets: Number(observedTotal) } };
}

function rankingConditions(options, alias = 'r', { publisher = true } = {}) {
    const conditions = [`${alias}.rankingKey IN ('most_read', 'most_commented', 'top_news')`];
    const params = [];
    if (options.startAt) { conditions.push(`julianday(${alias}.capturedAt) >= julianday(?)`); params.push(options.startAt); }
    conditions.push(`julianday(${alias}.capturedAt) < julianday(?)`); params.push(options.endAt);
    if (options.rankingKey) { conditions.push(`${alias}.rankingKey = ?`); params.push(options.rankingKey); }
    if (publisher && options.publisherId) { conditions.push(`${alias}.sourceId = ?`); params.push(options.publisherId); }
    return { where: conditions.join(' AND '), params };
}

function context(database, options, { ignorePublisher = false, states = true, includeBullshit = true, includeArticleRanks = true } = {}) {
    const config = options;
    const all = articleScope(config, { alias: 'a', period: false, publisher: !ignorePublisher });
    const current = articleScope(config, { alias: 'a', publisher: false, topic: false });
    const ranking = rankingConditions(config, 'r', { publisher: !ignorePublisher });
    const bullshit = !includeBullshit || database.bullshitRulesAvailable === false ? '0' : 'EXISTS (SELECT 1 FROM article_bullshit_matches b WHERE b.articleId = a.id)';
    return {
        sql: `WITH ranking_entries AS MATERIALIZED (
            SELECT r.id, r.articleId, r.sourceId, r.canonicalUrl, r.rankingKey FROM most_read r WHERE ${ranking.where}
        ), ranking_matches AS MATERIALIZED (
            SELECT r.id AS rankingId, r.rankingKey, a.id AS articleId, r.sourceId FROM ranking_entries r
                JOIN articles a ON a.id = r.articleId JOIN feeds f ON f.id = a.feedId AND f.sourceId = r.sourceId
            UNION
            SELECT r.id, r.rankingKey, a.id, r.sourceId FROM ranking_entries r
                JOIN articles a ON a.canonicalUrl = r.canonicalUrl JOIN feeds f ON f.id = a.feedId AND f.sourceId = r.sourceId
            UNION
            SELECT r.id, r.rankingKey, a.id, r.sourceId FROM ranking_entries r
                JOIN articles a ON a.url = r.canonicalUrl JOIN feeds f ON f.id = a.feedId AND f.sourceId = r.sourceId
        ), ranking_presence AS (
            SELECT DISTINCT articleId, sourceId FROM ranking_matches
        ), all_scoped AS MATERIALIZED (
            SELECT a.id, a.feedId, a.publishedAt, a.fetchedAt, a.classificationStatus, a.url, a.canonicalUrl,
                f.sourceId AS publisherId, ${names} AS feedName, s.name AS publisherName, ${articleKey('a')} AS articleKey,
                ${bullshit} AS bullshit,
                ${states ? 'EXISTS (SELECT 1 FROM list_items li WHERE li.articleId = a.id)' : '0'} AS saved,
                ${states ? 'EXISTS (SELECT 1 FROM article_state ast WHERE ast.articleId = a.id AND ast.readAt IS NOT NULL)' : '0'} AS isRead,
                ${states ? 'EXISTS (SELECT 1 FROM article_state ast WHERE ast.articleId = a.id AND ast.dismissedAt IS NOT NULL)' : '0'} AS dismissed,
                ${includeArticleRanks ? 'EXISTS (SELECT 1 FROM ranking_presence rp WHERE rp.articleId = a.id AND rp.sourceId = f.sourceId)' : '0'} AS ranked
            FROM articles a JOIN feeds f ON f.id = a.feedId JOIN sources s ON s.id = f.sourceId WHERE ${all.where}
        ), scoped AS MATERIALIZED (SELECT a.* FROM all_scoped a WHERE ${current.where}),
        volume AS (SELECT ${bucketFor(config)} AS bucket, COUNT(*) AS count FROM scoped a
            WHERE julianday(a.${config.timeBasis}) IS NOT NULL GROUP BY bucket)
        `,
        params: [...ranking.params, ...all.params, ...current.params], config,
    };
}

const volumeJson = (table = 'volume') => jsonRows({ fields: "'bucket', bucket, 'count', count", query: `SELECT * FROM (SELECT * FROM ${table} ORDER BY bucket DESC LIMIT ${POINT_LIMIT}) ORDER BY bucket` });
const topTopicsQuery = (limit = 10) => `SELECT t.id, t.slug, t.label, COUNT(DISTINCT a.id) AS count
    FROM scoped a JOIN article_topics at ON at.articleId = a.id JOIN topics t ON t.id = at.topicId
    GROUP BY t.id ORDER BY count DESC, t.label COLLATE NOCASE, t.id LIMIT ${limit}`;
const topicJson = query => jsonRows({ fields: "'id', id, 'slug', slug, 'label', label, 'count', count", query });

function metadata(options, collections = {}) {
    return {
        timezone: 'UTC', group: options.group, timeBasis: options.timeBasis,
        period: { startAt: options.startAt, endAt: options.endAt, previousStartAt: options.previousStartAt },
        limits: { rows: ROW_LIMIT, points: POINT_LIMIT, series: SERIES_LIMIT }, coverage: collections,
        definitions: {
            totalArticles: 'Stored articles matching publisher and topic filters, independent of the selected period.',
            periodArticles: 'Distinct stored articles whose selected timestamp is in the selected period; the end is exclusive.',
            shares: 'Percent of distinct articles in the selected period. Articles may have several topics; topic shares do not sum to 100%.',
            rankedArticles: 'Distinct selected local articles matched by valid articleId or exact canonical URL/URL to a ranking captured in the selected period for the same publisher. Ranking types are observations, not pageview counts.',
            activeFeeds: 'Configured feeds with an HTTP or HTTPS RSS URL; manual-import feeds are excluded. This does not indicate successful polling.',
            volume: 'UTC calendar buckets count stored article timestamps; missing article buckets are zero-filled within the selected period (or observed first-to-last span for All time). First and last calendar buckets can cover partial days, weeks or months. The latest 512 buckets are returned. Zero means no matching stored articles, not a successful collection attempt; collection continuity is unknown.',
        },
    };
}

/** Aggregates are performed in one SQLite statement so related values share a read snapshot. */
export async function readAnalyticsOverview(database, input = {}) {
    const options = filtersFor(input);
    const ctx = context(database, options);
    const feedScope = options.publisherId ? 'AND f.sourceId = ?' : '';
    const row = await database.get(`${ctx.sql} SELECT
        (SELECT COUNT(*) FROM all_scoped) AS totalArticles,
        COUNT(*) AS periodArticles, COALESCE(SUM(bullshit), 0) AS bullshitArticles,
        COALESCE(SUM(saved), 0) AS savedArticles, COALESCE(SUM(isRead), 0) AS readArticles,
        COALESCE(SUM(ranked), 0) AS rankedArticles,
        (SELECT COUNT(*) FROM feeds f WHERE (f.feedUrl LIKE 'https://%' OR f.feedUrl LIKE 'http://%') ${feedScope}) AS activeFeeds,
        ${volumeJson()} AS volume, (SELECT COUNT(*) FROM volume) AS volumeTotal, (SELECT MIN(bucket) FROM volume) AS volumeStart,
        ${jsonRows({ fields: "'id', id, 'publisherId', publisherId, 'name', name, 'publisherName', publisherName, 'count', count", query: `SELECT feedId AS id, publisherId, feedName AS name, publisherName, COUNT(*) AS count FROM scoped GROUP BY feedId ORDER BY count DESC, name COLLATE NOCASE, id LIMIT 10` })} AS topFeeds,
        ${topicJson(topTopicsQuery())} AS topTopics,
        (SELECT COUNT(DISTINCT feedId) FROM scoped) AS feedsTotal,
        (SELECT COUNT(DISTINCT at.topicId) FROM scoped a JOIN article_topics at ON at.articleId = a.id) AS topicsTotal FROM scoped`, [...ctx.params, ...(options.publisherId ? [options.publisherId] : [])]);
    const volumeResult = filledVolume(asArray(row.volume), options, { observedTotal: row.volumeTotal, firstBucket: row.volumeStart });
    const volume = volumeResult.points;
    return {
        filters: options,
        kpis: Object.fromEntries(['totalArticles', 'periodArticles', 'bullshitArticles', 'activeFeeds', 'savedArticles', 'readArticles', 'rankedArticles'].map(key => [key, Number(row[key])])),
        volume, topFeeds: asArray(row.topFeeds).map(item => ({ ...item, share: percent(item.count, row.periodArticles) })),
        topTopics: asArray(row.topTopics).map(item => ({ ...item, share: percent(item.count, row.periodArticles) })),
        metadata: metadata(options, { volume: volumeResult.coverage, topFeeds: coverage(asArray(row.topFeeds), row.feedsTotal), topTopics: coverage(asArray(row.topTopics), row.topicsTotal) }),
    };
}

function momentumCtes(options) {
    if (!options.previousStartAt || !options.startAt) return { sql: ', momentum AS (SELECT id, slug, label, 0 AS previous, 0 AS current FROM topics WHERE 0)', params: [] };
    return {
        sql: `, momentum AS (
            SELECT t.id, t.slug, t.label,
                COUNT(DISTINCT CASE WHEN julianday(a.${options.timeBasis}) >= julianday(?) AND julianday(a.${options.timeBasis}) < julianday(?) THEN a.id END) AS previous,
                COUNT(DISTINCT CASE WHEN julianday(a.${options.timeBasis}) >= julianday(?) AND julianday(a.${options.timeBasis}) < julianday(?) THEN a.id END) AS current
            FROM all_scoped a JOIN article_topics at ON at.articleId = a.id JOIN topics t ON t.id = at.topicId
            WHERE julianday(a.${options.timeBasis}) >= julianday(?) AND julianday(a.${options.timeBasis}) < julianday(?) GROUP BY t.id
        )`,
        params: [options.previousStartAt, options.startAt, options.startAt, options.endAt, options.previousStartAt, options.endAt],
    };
}
const momentumJson = () => jsonRows({ fields: "'id', id, 'slug', slug, 'label', label, 'previous', previous, 'current', current", query: `SELECT * FROM momentum ORDER BY (current - previous) DESC, current DESC, label COLLATE NOCASE, id LIMIT ${ROW_LIMIT}` });
function withMomentum(rows) {
    return rows.map(item => ({ ...item, change: item.current - item.previous,
        percentChange: item.previous ? Number(((item.current - item.previous) * 100 / item.previous).toFixed(2)) : null,
        emerging: item.current >= 5 && item.current - item.previous >= 5 && (item.previous === 0 || item.current >= 2 * item.previous),
    }));
}
function momentumMetadata(options) {
    return {
        available: Boolean(options.startAt && options.previousStartAt),
        reason: options.startAt ? null : 'An immediately preceding period of equal duration is undefined for All time.',
        calculation: 'Current minus previous count; percentage is null when the previous count is zero.',
        emerging: { minimumCurrent: 5, minimumAbsoluteGrowth: 5, minimumRatio: 2, zeroBaseline: 'At least 5 current articles; percentage remains unavailable.' },
    };
}

export async function readAnalyticsTrends(database, input = {}) {
    const options = filtersFor(input);
    const ctx = context(database, options, { states: false, includeBullshit: false, includeArticleRanks: false });
    const momentum = momentumCtes(options);
    const selectedTopics = options.topicSlugs?.length ? options.topicSlugs : [];
    const selectedSql = selectedTopics.length ? `SELECT id, slug, label FROM topics WHERE slug IN (SELECT value FROM json_each(?)) ORDER BY label COLLATE NOCASE LIMIT ${SERIES_LIMIT}` : `SELECT id, slug, label FROM (${topTopicsQuery(5)})`;
    const row = await database.get(`${ctx.sql}${momentum.sql}, selected_topics AS (${selectedSql}), topic_points AS (
        SELECT t.id, ${bucketFor(options)} AS bucket, COUNT(DISTINCT a.id) AS count
        FROM scoped a JOIN article_topics at ON at.articleId = a.id JOIN selected_topics t ON t.id = at.topicId
        GROUP BY t.id, bucket
    ) SELECT ${volumeJson()} AS volume, (SELECT COUNT(*) FROM volume) AS volumeTotal, (SELECT MIN(bucket) FROM volume) AS volumeStart,
        ${momentumJson()} AS momentum, (SELECT COUNT(*) FROM momentum) AS momentumTotal,
        (SELECT COALESCE(json_group_array(json_object('id', t.id, 'slug', t.slug, 'label', t.label,
            'points', json(${jsonRows({ fields: "'bucket', bucket, 'count', count", query: `SELECT * FROM (SELECT bucket, count FROM topic_points WHERE id = t.id ORDER BY bucket DESC LIMIT ${POINT_LIMIT}) ORDER BY bucket` })}),
            'totalPoints', (SELECT COUNT(*) FROM topic_points p WHERE p.id = t.id), 'firstBucket', (SELECT MIN(bucket) FROM topic_points p WHERE p.id = t.id))), '[]') FROM selected_topics t) AS topicSeries`,
    [...ctx.params, ...momentum.params, ...(selectedTopics.length ? [JSON.stringify(selectedTopics)] : [])]);
    const volumeResult = filledVolume(asArray(row.volume), options, { observedTotal: row.volumeTotal, firstBucket: row.volumeStart });
    const volume = volumeResult.points, series = asArray(row.topicSeries).map(item => ({ ...item, filled: filledVolume(item.points, options, { observedTotal: item.totalPoints, firstBucket: item.firstBucket }) })), changes = withMomentum(asArray(row.momentum));
    const meta = metadata(options, { volume: volumeResult.coverage, momentum: coverage(changes, row.momentumTotal), topicSeries: coverage(series, selectedTopics.length || series.length) });
    meta.momentum = momentumMetadata(options);
    meta.coverage.topicPoints = series.map(item => ({ slug: item.slug, ...item.filled.coverage }));
    return { filters: options, volume, topicSeries: series.map(({ totalPoints, firstBucket, filled, ...item }) => ({ ...item, points: filled.points })), momentum: changes, emerging: changes.filter(item => item.emerging), metadata: meta };
}

function supportFor(row, feed = false) {
    const urls = (feed ? [row.feedUrl] : asArray(row.feedUrls)).filter(value => /^https?:\/\//i.test(value || ''));
    const providers = urls.map(feedUrl => rankingMediumForSource({ websiteUrl: row.websiteUrl, feedUrl })).filter(Boolean);
    const keys = [...new Set(providers.flatMap(provider => provider.rankingKeys))];
    return { rankingSupported: keys.length > 0, rankingKeys: keys, rankingMedia: [...new Set(providers.map(provider => provider.id))] };
}
function publisherRow(row, options, feed = false) {
    const support = supportFor(row, feed);
    const days = options.days || Number(row.observedDays) || 1;
    const { feedUrls, feedUrl, observedDays, ...data } = row;
    return { ...data, ...support, averagePerDay: Number((row.periodArticles / days).toFixed(2)),
        bullshitRate: percent(row.bullshitArticles, row.periodArticles),
        rankedArticles: support.rankingSupported && (!options.rankingKey || support.rankingKeys.includes(options.rankingKey)) ? Number(row.rankedArticles) : null };
}

export async function readAnalyticsPublishers(database, input = {}) {
    const options = filtersFor(input);
    // Comparison deliberately retains the shared period/topic while selecting its own two publishers.
    const ctx = context(database, options, { ignorePublisher: true, states: false });
    const publisherWhere = options.publisherId ? 'WHERE s.id = ?' : '';
    const feedWhere = options.publisherId ? 'WHERE f.publisherId = ?' : '';
    const comparisonBucket = options.group === 'month' ? "strftime('%Y-%m-01', observedAt)" : options.group === 'week' ? "date(observedAt, '-6 days', 'weekday 1')" : 'date(observedAt)';
    const selectedIds = [...new Set(options.compareIds || [])].slice(0, 2);
    const sortColumns = { name: 'name COLLATE NOCASE', totalArticles: 'totalArticles', periodArticles: 'periodArticles', averagePerDay: options.days ? 'periodArticles' : '1.0 * periodArticles / observedDays', bullshitArticles: 'bullshitArticles', bullshitRate: 'CASE WHEN periodArticles > 0 THEN 1.0 * bullshitArticles / periodArticles END', rankedArticles: 'rankedArticles' };
    const sort = sortColumns[options.sort] || 'periodArticles';
    const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
    const row = await database.get(`${ctx.sql}, publisher_articles AS (SELECT publisherId, articleKey, MAX(bullshit) AS bullshit, MAX(ranked) AS ranked, MIN(julianday(${options.timeBasis})) AS observedAt FROM scoped GROUP BY publisherId, articleKey),
    publisher_counts AS (
        SELECT publisherId, COUNT(DISTINCT articleKey) AS totalArticles FROM all_scoped GROUP BY publisherId
    ), publisher_period AS (
        SELECT publisherId, COUNT(*) AS periodArticles, SUM(bullshit) AS bullshitArticles, SUM(ranked) AS rankedArticles,
            MAX(1, MAX(observedAt) - MIN(observedAt) + 1) AS observedDays FROM publisher_articles GROUP BY publisherId
    ), feed_articles AS (SELECT feedId, articleKey, MAX(bullshit) AS bullshit, MAX(ranked) AS ranked, MIN(julianday(${options.timeBasis})) AS observedAt FROM scoped GROUP BY feedId, articleKey),
    feed_counts AS (SELECT feedId, COUNT(DISTINCT articleKey) AS totalArticles FROM all_scoped GROUP BY feedId),
    feed_period AS (SELECT feedId, COUNT(*) AS periodArticles, SUM(bullshit) AS bullshitArticles, SUM(ranked) AS rankedArticles,
            MAX(1, MAX(observedAt) - MIN(observedAt) + 1) AS observedDays FROM feed_articles GROUP BY feedId),
    publisher_rows AS (SELECT s.id, s.name, s.websiteUrl,
        (SELECT json_group_array(feedUrl) FROM feeds WHERE sourceId = s.id) AS feedUrls,
        COALESCE(c.totalArticles, 0) AS totalArticles, COALESCE(p.periodArticles, 0) AS periodArticles,
        COALESCE(p.bullshitArticles, 0) AS bullshitArticles, COALESCE(p.rankedArticles, 0) AS rankedArticles, COALESCE(p.observedDays, 1) AS observedDays
        FROM sources s LEFT JOIN publisher_counts c ON c.publisherId = s.id LEFT JOIN publisher_period p ON p.publisherId = s.id),
    feed_rows AS (SELECT f.id, ${names} AS name, s.id AS publisherId, s.name AS publisherName, s.websiteUrl, f.feedUrl,
        COALESCE(c.totalArticles, 0) AS totalArticles, COALESCE(p.periodArticles, 0) AS periodArticles,
        COALESCE(p.bullshitArticles, 0) AS bullshitArticles, COALESCE(p.rankedArticles, 0) AS rankedArticles, COALESCE(p.observedDays, 1) AS observedDays
        FROM feeds f JOIN sources s ON s.id = f.sourceId LEFT JOIN feed_counts c ON c.feedId = f.id LEFT JOIN feed_period p ON p.feedId = f.id)
    SELECT
        ${jsonRows({ fields: "'id', id, 'name', name, 'websiteUrl', websiteUrl, 'feedUrls', json(feedUrls), 'totalArticles', totalArticles, 'periodArticles', periodArticles, 'bullshitArticles', bullshitArticles, 'rankedArticles', rankedArticles, 'observedDays', observedDays", query: `SELECT s.* FROM publisher_rows s ${publisherWhere} ORDER BY ${sort} ${direction}, id LIMIT ${ROW_LIMIT}` })} AS publishers,
        ${jsonRows({ fields: "'id', id, 'name', name, 'publisherId', publisherId, 'publisherName', publisherName, 'websiteUrl', websiteUrl, 'feedUrl', feedUrl, 'totalArticles', totalArticles, 'periodArticles', periodArticles, 'bullshitArticles', bullshitArticles, 'rankedArticles', rankedArticles, 'observedDays', observedDays", query: `SELECT f.* FROM feed_rows f ${feedWhere} ORDER BY ${sort} ${direction}, id LIMIT ${ROW_LIMIT}` })} AS feeds,
        (SELECT COUNT(*) FROM publisher_rows s ${publisherWhere}) AS publishersTotal,
        (SELECT COUNT(*) FROM feed_rows f ${feedWhere}) AS feedsTotal,
        (SELECT COALESCE(json_group_array(json_object('id', s.id, 'name', s.name, 'websiteUrl', s.websiteUrl, 'feedUrls', json(s.feedUrls),
            'totalArticles', s.totalArticles, 'periodArticles', s.periodArticles, 'bullshitArticles', s.bullshitArticles, 'rankedArticles', s.rankedArticles, 'observedDays', s.observedDays,
            'volumeTotal', (SELECT COUNT(DISTINCT ${comparisonBucket}) FROM publisher_articles a WHERE a.publisherId = s.id),
            'volumeStart', (SELECT MIN(${comparisonBucket}) FROM publisher_articles a WHERE a.publisherId = s.id),
            'rankingAppearances', json(${jsonRows({ fields: "'rankingKey', rankingKey, 'articles', articles, 'appearances', appearances", query: `SELECT r.rankingKey, COUNT(DISTINCT a.articleKey) AS articles, COUNT(DISTINCT r.rankingId) AS appearances FROM scoped a JOIN ranking_matches r ON r.articleId = a.id AND r.sourceId = a.publisherId WHERE a.publisherId = s.id GROUP BY r.rankingKey ORDER BY r.rankingKey` })}),
            'volume', json(${jsonRows({ fields: "'bucket', bucket, 'count', count", query: `SELECT * FROM (SELECT ${comparisonBucket} AS bucket, COUNT(*) AS count FROM publisher_articles a WHERE a.publisherId = s.id GROUP BY bucket ORDER BY bucket DESC LIMIT ${POINT_LIMIT}) ORDER BY bucket` })}),
            'topics', json(${topicJson(`SELECT t.id, t.slug, t.label, COUNT(DISTINCT a.articleKey) AS count FROM scoped a JOIN article_topics at ON at.articleId = a.id JOIN topics t ON t.id = at.topicId WHERE a.publisherId = s.id GROUP BY t.id ORDER BY count DESC, t.label COLLATE NOCASE LIMIT 10`)}))), '[]') FROM publisher_rows s WHERE s.id IN (SELECT value FROM json_each(?))) AS comparison`,
    [...ctx.params, ...(options.publisherId ? [options.publisherId, options.publisherId, options.publisherId, options.publisherId] : []), JSON.stringify(selectedIds)]);
    const publishers = asArray(row.publishers).map(item => publisherRow(item, options));
    const feeds = asArray(row.feeds).map(item => publisherRow(item, options, true));
    const comparison = asArray(row.comparison).map(item => {
        const filled = filledVolume(item.volume, options, { observedTotal: item.volumeTotal, firstBucket: item.volumeStart });
        const { volumeTotal, volumeStart, ...data } = publisherRow(item, options);
        return { ...data, volume: filled.points, coverage: { volume: filled.coverage }, topics: item.topics.map(topic => ({ ...topic, share: percent(topic.count, item.periodArticles) })) };
    });
    const meta = metadata(options, { publishers: coverage(publishers, row.publishersTotal), feeds: coverage(feeds, row.feedsTotal), comparison: coverage(comparison, selectedIds.length) });
    meta.definitions.averagePerDay = 'Selected-period count divided by the exact selected duration in days. All time uses the first-to-last observed article span, at least one day.';
    meta.definitions.rankingCoverage = 'Supported collection is determined from configured publisher/feed URLs. Unsupported ranking metrics are unavailable (null), never zero. Publisher counts deduplicate exact trimmed canonical URLs (URL fallback, then article ID) within each publisher, combining positive flags across copies. Feed rows apply the same identity within each feed and are a separate breakdown. Collection tracking parameters are not normalized.';
    meta.definitions.publisherIdentity = 'Publisher/feed totals, rates and comparisons use unique URL identities; Overview, Topics and Library use distinct stored article IDs. Comparison volume assigns a URL once to its earliest selected timestamp.';
    meta.definitions.comparison = 'Comparison selects its two publishers independently of the global publisher filter and retains the period and topic filters.';
    meta.rankingMedia = RANKING_MEDIA.map(({ id, name, rankingKeys }) => ({ id, name, rankingKeys }));
    return { filters: options, publishers, feeds, comparison, metadata: meta };
}

export async function readAnalyticsTopics(database, input = {}) {
    const options = filtersFor(input), ctx = context(database, options, { states: false, includeBullshit: false, includeArticleRanks: false }), momentum = momentumCtes(options);
    const row = await database.get(`${ctx.sql}${momentum.sql}, topic_counts AS (${topTopicsQuery(ROW_LIMIT)}),
        topic_publishers AS (SELECT t.id AS topicId, t.slug, t.label, a.publisherId, a.publisherName, COUNT(DISTINCT a.id) AS count
            FROM scoped a JOIN article_topics at ON at.articleId = a.id JOIN topics t ON t.id = at.topicId
            GROUP BY t.id, a.publisherId),
        pairs AS (SELECT l.id AS leftId, l.slug AS leftSlug, l.label AS leftLabel, r.id AS rightId, r.slug AS rightSlug, r.label AS rightLabel, COUNT(DISTINCT a.id) AS count
            FROM scoped a JOIN article_topics al ON al.articleId = a.id JOIN article_topics ar ON ar.articleId = a.id AND ar.topicId > al.topicId
            JOIN topics l ON l.id = al.topicId JOIN topics r ON r.id = ar.topicId GROUP BY l.id, r.id)
        SELECT (SELECT COUNT(*) FROM scoped) AS total,
        (SELECT COUNT(DISTINCT a.id) FROM scoped a JOIN ranking_matches r ON r.articleId = a.id AND r.sourceId = a.publisherId) AS rankedTotal,
        ${topicJson('SELECT * FROM topic_counts')} AS topics,
        (SELECT COUNT(DISTINCT at.topicId) FROM scoped a JOIN article_topics at ON at.articleId = a.id) AS topicsTotal,
        ${jsonRows({ fields: "'topicId', topicId, 'slug', slug, 'label', label, 'publisherId', publisherId, 'publisherName', publisherName, 'count', count", query: `SELECT * FROM topic_publishers ORDER BY count DESC, label COLLATE NOCASE, publisherName COLLATE NOCASE LIMIT ${ROW_LIMIT}` })} AS publishers,
        (SELECT COUNT(*) FROM topic_publishers) AS publishersTotal,
        ${volumeJson()} AS volume, (SELECT COUNT(*) FROM volume) AS volumeTotal, (SELECT MIN(bucket) FROM volume) AS volumeStart,
        ${momentumJson()} AS momentum, (SELECT COUNT(*) FROM momentum) AS momentumTotal,
        ${jsonRows({ fields: "'leftId', leftId, 'leftSlug', leftSlug, 'leftLabel', leftLabel, 'rightId', rightId, 'rightSlug', rightSlug, 'rightLabel', rightLabel, 'count', count", query: `SELECT * FROM pairs ORDER BY count DESC, leftLabel COLLATE NOCASE, rightLabel COLLATE NOCASE LIMIT ${ROW_LIMIT}` })} AS cooccurrence,
        (SELECT COUNT(*) FROM pairs) AS pairsTotal,
        ${jsonRows({ fields: "'rankingKey', rankingKey, 'count', count, 'appearances', appearances", query: `SELECT r.rankingKey, COUNT(DISTINCT a.id) AS count, COUNT(DISTINCT r.rankingId) AS appearances FROM scoped a JOIN ranking_matches r ON r.articleId = a.id AND r.sourceId = a.publisherId GROUP BY r.rankingKey ORDER BY r.rankingKey` })} AS rankings`,
    [...ctx.params, ...momentum.params]);
    const topics = asArray(row.topics).map(item => ({ ...item, share: percent(item.count, row.total) }));
    const volumeResult = filledVolume(asArray(row.volume), options, { observedTotal: row.volumeTotal, firstBucket: row.volumeStart });
    const publishers = asArray(row.publishers), volume = volumeResult.points, changes = withMomentum(asArray(row.momentum)), cooccurrence = asArray(row.cooccurrence);
    const meta = metadata(options, { topics: coverage(topics, row.topicsTotal), publishers: coverage(publishers, row.publishersTotal), volume: volumeResult.coverage, momentum: coverage(changes, row.momentumTotal), cooccurrence: coverage(cooccurrence, row.pairsTotal) });
    meta.momentum = momentumMetadata(options);
    meta.definitions.cooccurrence = 'Distinct local articles containing both stored topic associations. Classification is not rerun. Selecting a topic limits every drilldown to articles containing that topic.';
    return { filters: options, kpis: { totalArticles: Number(row.total), rankedArticles: Number(row.rankedTotal) }, topics, publishers, volume, momentum: changes, cooccurrence, rankings: asArray(row.rankings), metadata: meta };
}

export async function readAnalyticsLibrary(database, input = {}) {
    const options = filtersFor(input), ctx = context(database, options, { includeBullshit: false, includeArticleRanks: false });
    const fetchedBucket = bucketFor({ ...options, timeBasis: 'fetchedAt' });
    const row = await database.get(`${ctx.sql}, collection AS (
        SELECT ${fetchedBucket} AS bucket, COUNT(*) AS count FROM scoped a WHERE julianday(a.fetchedAt) IS NOT NULL GROUP BY bucket
    ), duplicate_urls AS (
        SELECT COALESCE(NULLIF(TRIM(canonicalUrl), ''), NULLIF(TRIM(url), '')) AS url, COUNT(*) AS count FROM scoped
        WHERE COALESCE(NULLIF(TRIM(canonicalUrl), ''), NULLIF(TRIM(url), '')) IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1
    ), fresh AS (
        SELECT f.id, ${names} AS name, s.id AS publisherId, s.name AS publisherName,
            (SELECT fetchedAt FROM articles a WHERE a.feedId = f.id AND julianday(a.fetchedAt) IS NOT NULL ORDER BY julianday(a.fetchedAt) DESC, a.id DESC LIMIT 1) AS lastFetchedAt
        FROM feeds f JOIN sources s ON s.id = f.sourceId WHERE (f.feedUrl LIKE 'http://%' OR f.feedUrl LIKE 'https://%')
        ${options.publisherId ? 'AND s.id = ?' : ''}
    ) SELECT (SELECT COUNT(*) FROM all_scoped) AS totalArticles, COUNT(*) AS periodArticles,
        COALESCE(SUM(isRead), 0) AS readArticles, COUNT(*) - COALESCE(SUM(isRead), 0) AS unreadArticles,
        COALESCE(SUM(saved), 0) AS savedArticles, COALESCE(SUM(dismissed), 0) AS dismissedArticles,
        (SELECT COUNT(*) FROM scoped a WHERE NOT EXISTS (SELECT 1 FROM article_topics at WHERE at.articleId = a.id)) AS unclassifiedArticles,
        (SELECT COUNT(*) FROM feeds ${options.publisherId ? 'WHERE sourceId = ?' : ''}) AS feeds,
        (SELECT COUNT(*) FROM sources ${options.publisherId ? 'WHERE id = ?' : ''}) AS publishers,
        ${jsonRows({ fields: "'status', classificationStatus, 'count', count", query: 'SELECT classificationStatus, COUNT(*) AS count FROM scoped GROUP BY classificationStatus ORDER BY classificationStatus' })} AS classification,
        ${volumeJson('collection')} AS collection, (SELECT COUNT(*) FROM collection) AS collectionTotal, (SELECT MIN(bucket) FROM collection) AS collectionStart,
        (SELECT COUNT(*) FROM ranking_entries r WHERE NOT EXISTS (SELECT 1 FROM ranking_matches m WHERE m.rankingId = r.id)) AS orphanRankingRecords,
        (SELECT COUNT(*) FROM duplicate_urls) AS duplicateUrlGroups,
        (SELECT COALESCE(SUM(count), 0) FROM duplicate_urls) AS duplicateUrlArticles,
        ${jsonRows({ fields: "'id', id, 'name', name, 'publisherId', publisherId, 'publisherName', publisherName, 'lastFetchedAt', lastFetchedAt, 'articleCount', articleCount", query: `SELECT fresh.*, (SELECT COUNT(*) FROM scoped a WHERE a.feedId = fresh.id) AS articleCount FROM fresh ORDER BY lastFetchedAt IS NOT NULL, julianday(lastFetchedAt), id LIMIT ${ROW_LIMIT}` })} AS feedFreshness,
        (SELECT COUNT(*) FROM fresh) AS freshnessTotal FROM scoped`,
    [...ctx.params, ...(options.publisherId ? [options.publisherId, options.publisherId, options.publisherId] : [])]);
    const collectionResult = filledVolume(asArray(row.collection), { ...options, startAt: null }, { observedTotal: row.collectionTotal, firstBucket: row.collectionStart });
    const collection = collectionResult.points, feedFreshness = asArray(row.feedFreshness);
    const meta = metadata(options, { collection: collectionResult.coverage, feedFreshness: coverage(feedFreshness, row.freshnessTotal) });
    meta.definitions.library = 'Total stored articles ignores the period; article state, classification and URL diagnostics use selected articles. Read and unread are defined by readAt; dismissed articles may also be unread. Feed and publisher counts are configuration counts, independent of topic and time.';
    meta.definitions.collection = 'Fetched-at buckets for articles selected by the shared timestamp filter. This records stored collection timestamps, not collection attempts or polling success.';
    meta.definitions.unclassifiedArticles = 'Selected articles with no stored topic association, including classified articles with no matching topics.';
    meta.definitions.orphanRankingRecords = 'Captured ranking rows with no same-publisher local article matched by valid articleId or exact canonical URL/URL, filtered by capture period and publisher. Topic is inapplicable because a missing local article has no stored topics. This is expected for ranking-only URLs and is diagnostic, not a confirmed error.';
    meta.definitions.duplicateUrls = 'Exact trimmed canonical URL (falling back to URL) shared by multiple selected local records; these are potential duplicates, not confirmed errors. Article count includes all members of duplicate groups.';
    meta.definitions.feedFreshness = 'Latest actual stored fetchedAt per configured RSS feed across all articles. This is independent of topic/time and does not establish the most recent polling attempt or current feed health.';
    return { filters: options,
        kpis: Object.fromEntries(['totalArticles', 'periodArticles', 'readArticles', 'unreadArticles', 'savedArticles', 'dismissedArticles', 'unclassifiedArticles', 'feeds', 'publishers'].map(key => [key, Number(row[key])])),
        classification: asArray(row.classification), collection,
        quality: Object.fromEntries(['orphanRankingRecords', 'duplicateUrlGroups', 'duplicateUrlArticles'].map(key => [key, Number(row[key])])),
        feedFreshness, metadata: meta };
}
