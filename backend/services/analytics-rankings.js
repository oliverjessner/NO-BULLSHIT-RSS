import { cleanHttpUrl } from '../utils/url.js';

const RANKING_TYPES = [
    { key: 'most_read', label: 'Most read' },
    { key: 'most_commented', label: 'Most commented' },
    { key: 'top_news', label: 'Editorial Top-News' },
];
const MOVEMENT_TYPES = ['climbers', 'decliners', 'unchanged', 'newEntries', 'droppedOut', 'unavailable'];

const METHODOLOGY = {
    identity: 'Distinct stored canonical URLs; publisher and ranking type remain separate in article tables.',
    newEntries: 'First ever observation of a canonical URL within the selected publisher and ranking-type scope.',
    changes: 'Latest two actual snapshots per publisher and ranking type; the previous snapshot can precede the selected period.',
    snapshots: 'A snapshot is a distinct publisher, ranking type and captured timestamp. Snapshot counts describe collection coverage and are independent of the topic filter.',
    history: 'Null ranks mean absence from an actual captured snapshot. No missing captures or regular capture intervals are invented.',
    observedSpan: 'Elapsed time between first and last observed appearances, not uninterrupted time in a ranking.',
    topicShare: 'Eligible distinct local article URLs published (or fetched with that time basis) in the period, restricted to publishers with captured data for that ranking type. The numerator uses the same eligible articles.',
    limitations: 'Positions are not pageviews or direct audience measurements. Top-News is an editorial selection. Empty captures and collection failures are not represented in the stored ranking table, so complete collection gaps cannot be reconstructed. Topic coverage uses current stored classifications; unmatched external articles have no local topics.',
};

function createScope(options) {
    const params = [];
    const conditions = ['julianday(capturedAt) < julianday(?)'];
    params.push(options.endAt);
    if (options.publisherId != null) { conditions.push('sourceId = ?'); params.push(options.publisherId); }
    if (options.rankingKey) { conditions.push('rankingKey = ?'); params.push(options.rankingKey); }
    const startCondition = options.startAt ? 'julianday(capturedAt) >= julianday(?)' : '1 = 1';
    const startParams = options.startAt ? [options.startAt] : [];
    const topicCondition = options.topic ? `EXISTS (SELECT 1 FROM association_topics ast
        WHERE ast.sourceId = h.sourceId AND ast.canonicalUrl = h.canonicalUrl AND ast.slug = ?)` : '1 = 1';
    const topicParams = options.topic ? [options.topic] : [];
    // Resolve once per distinct URL rather than once per historical observation.
    // Matching every local copy also preserves topics where RSS feeds overlap.
    const sql = `WITH history AS MATERIALIZED (
        SELECT id, sourceId, articleId, canonicalUrl, title, rank, rankingKey,
            strftime('%Y-%m-%dT%H:%M:%fZ', capturedAt) AS capturedAt
        FROM most_read WHERE ${conditions.join(' AND ')}
    ), associations AS MATERIALIZED (
        SELECT sourceId, canonicalUrl, MAX(articleId) AS articleId FROM history GROUP BY sourceId, canonicalUrl
    ), article_links AS MATERIALIZED (
        SELECT links.sourceId, links.canonicalUrl, links.articleId FROM (
            SELECT r.sourceId, r.canonicalUrl, a.id AS articleId FROM associations r
                JOIN articles a ON a.id = r.articleId JOIN feeds f ON f.id = a.feedId AND f.sourceId = r.sourceId
            UNION
            SELECT r.sourceId, r.canonicalUrl, a.id FROM associations r
                JOIN articles a ON a.canonicalUrl = r.canonicalUrl JOIN feeds f ON f.id = a.feedId AND f.sourceId = r.sourceId
            UNION
            SELECT r.sourceId, r.canonicalUrl, a.id FROM associations r
                JOIN articles a ON a.url = r.canonicalUrl JOIN feeds f ON f.id = a.feedId AND f.sourceId = r.sourceId
        ) links
    ), association_topics AS MATERIALIZED (
        SELECT DISTINCT l.sourceId, l.canonicalUrl, t.id AS topicId, t.slug, t.label
        FROM article_links l JOIN article_topics at ON at.articleId = l.articleId JOIN topics t ON t.id = at.topicId
    ), resolved AS MATERIALIZED (
        SELECT sourceId, canonicalUrl, MIN(articleId) AS articleId FROM article_links GROUP BY sourceId, canonicalUrl
    ), eligible_history AS MATERIALIZED (
        SELECT h.*, r.articleId AS localArticleId FROM history h
        LEFT JOIN resolved r ON r.sourceId = h.sourceId AND r.canonicalUrl = h.canonicalUrl
        WHERE ${topicCondition}
    ), period_records AS MATERIALIZED (
        SELECT * FROM eligible_history WHERE ${startCondition}
    ), snapshots AS MATERIALIZED (
        SELECT DISTINCT sourceId, rankingKey, capturedAt FROM history
    ), period_snapshots AS MATERIALIZED (
        SELECT * FROM snapshots WHERE ${startCondition}
    )`;
    return { sql, params: [...params, ...topicParams, ...startParams, ...startParams], startCondition, startParams };
}

const performanceColumns = `sourceId, sourceName, rankingKey, canonicalUrl, title, articleId,
    bestRank, latestRank, firstCaptured, lastCaptured, snapshotAppearances`;
const performanceObject = `json_object('sourceId', sourceId, 'sourceName', sourceName, 'rankingKey', rankingKey,
    'canonicalUrl', canonicalUrl, 'title', title, 'articleId', articleId, 'bestRank', bestRank, 'latestRank', latestRank,
    'firstCaptured', firstCaptured, 'lastCaptured', lastCaptured, 'snapshotAppearances', snapshotAppearances)`;
const movementObject = `json_object('sourceId', sourceId, 'sourceName', sourceName, 'rankingKey', rankingKey,
    'canonicalUrl', canonicalUrl, 'title', title, 'articleId', articleId, 'previousRank', previousRank,
    'currentRank', currentRank, 'change', change, 'previousCapturedAt', previousCapturedAt, 'capturedAt', capturedAt)`;
const orderColumns = new Set(['bestRank', 'latestRank', 'snapshotAppearances', 'firstCaptured', 'lastCaptured', 'title', 'sourceName', 'rankingKey']);
const decode = value => value ? JSON.parse(value) : [];
const withSpan = row => ({ ...row, observedSpanMs: Math.max(0, Date.parse(row.lastCaptured) - Date.parse(row.firstCaptured)) });

/** Read historical ranking aggregates without changing ranking collection or article state. */
export async function readAnalyticsMostRead(database, options) {
    const scope = createScope(options);
    const limit = Math.min(200, Math.max(1, options.limit || 100));
    const offset = Math.max(0, options.offset || 0);
    const sort = orderColumns.has(options.sort) ? options.sort : 'bestRank';
    const direction = orderColumns.has(options.sort) && options.direction === 'desc' ? 'DESC' : 'ASC';
    const eligibleDates = [`julianday(a.${options.timeBasis === 'fetchedAt' ? 'fetchedAt' : 'publishedAt'}) < julianday(?)`];
    const eligibleParams = [options.endAt];
    if (options.startAt) {
        eligibleDates.push(`julianday(a.${options.timeBasis === 'fetchedAt' ? 'fetchedAt' : 'publishedAt'}) >= julianday(?)`);
        eligibleParams.push(options.startAt);
    }
    const row = await database.get(`${scope.sql}, first_seen AS (
        SELECT canonicalUrl, MIN(capturedAt) AS firstCaptured FROM eligible_history GROUP BY canonicalUrl
    ), ordered_period AS (
        SELECT p.*, ROW_NUMBER() OVER (PARTITION BY sourceId, rankingKey, canonicalUrl ORDER BY capturedAt DESC, id DESC) AS position
        FROM period_records p
    ), performance AS MATERIALIZED (
        SELECT p.sourceId, s.name AS sourceName, p.rankingKey, p.canonicalUrl,
            COALESCE(MAX(CASE WHEN p.position = 1 THEN p.title END), a.title, p.canonicalUrl) AS title,
            MAX(p.localArticleId) AS articleId, MIN(p.rank) AS bestRank,
            MAX(CASE WHEN p.position = 1 THEN p.rank END) AS latestRank,
            MIN(p.capturedAt) AS firstCaptured, MAX(p.capturedAt) AS lastCaptured,
            COUNT(DISTINCT p.capturedAt) AS snapshotAppearances
        FROM ordered_period p JOIN sources s ON s.id = p.sourceId LEFT JOIN articles a ON a.id = p.localArticleId
        GROUP BY p.sourceId, p.rankingKey, p.canonicalUrl
    ), snapshot_order AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY sourceId, rankingKey ORDER BY capturedAt DESC) AS position FROM snapshots
    ), pair_times AS MATERIALIZED (
        SELECT sourceId, rankingKey, MAX(CASE WHEN position = 1 THEN capturedAt END) AS capturedAt,
            MAX(CASE WHEN position = 2 THEN capturedAt END) AS previousCapturedAt
        FROM snapshot_order WHERE position <= 2 GROUP BY sourceId, rankingKey
        HAVING ${options.startAt ? 'julianday(MAX(CASE WHEN position = 1 THEN capturedAt END)) >= julianday(?)' : '1 = 1'}
    ), pair_urls AS (
        SELECT DISTINCT h.sourceId, h.rankingKey, h.canonicalUrl
        FROM eligible_history h JOIN pair_times pt ON pt.sourceId = h.sourceId AND pt.rankingKey = h.rankingKey
            AND h.capturedAt IN (pt.capturedAt, pt.previousCapturedAt)
    ), movements AS MATERIALIZED (
        SELECT u.sourceId, s.name AS sourceName, u.rankingKey, u.canonicalUrl,
            COALESCE(c.title, p.title, a.title, u.canonicalUrl) AS title,
            COALESCE(c.localArticleId, p.localArticleId) AS articleId,
            p.rank AS previousRank, c.rank AS currentRank,
            CASE WHEN p.rank IS NOT NULL AND c.rank IS NOT NULL THEN p.rank - c.rank END AS change,
            pt.previousCapturedAt, pt.capturedAt,
            CASE WHEN pt.previousCapturedAt IS NULL THEN 'unavailable'
                WHEN p.rank IS NULL THEN 'newEntries' WHEN c.rank IS NULL THEN 'droppedOut'
                WHEN p.rank > c.rank THEN 'climbers' WHEN p.rank < c.rank THEN 'decliners' ELSE 'unchanged' END AS status
        FROM pair_urls u JOIN pair_times pt ON pt.sourceId = u.sourceId AND pt.rankingKey = u.rankingKey
        JOIN sources s ON s.id = u.sourceId
        LEFT JOIN eligible_history c ON c.sourceId = u.sourceId AND c.rankingKey = u.rankingKey AND c.canonicalUrl = u.canonicalUrl AND c.capturedAt = pt.capturedAt
        LEFT JOIN eligible_history p ON p.sourceId = u.sourceId AND p.rankingKey = u.rankingKey AND p.canonicalUrl = u.canonicalUrl AND p.capturedAt = pt.previousCapturedAt
        LEFT JOIN articles a ON a.id = COALESCE(c.localArticleId, p.localArticleId)
    ), coverage AS MATERIALIZED (
        SELECT DISTINCT sourceId, rankingKey FROM period_snapshots
    ), eligible_articles AS MATERIALIZED (
        SELECT DISTINCT f.sourceId, COALESCE(NULLIF(a.canonicalUrl, ''), NULLIF(a.url, ''), 'article:' || a.id) AS canonicalUrl,
            t.id AS topicId, t.slug, t.label
        FROM articles a JOIN feeds f ON f.id = a.feedId
        JOIN article_topics at ON at.articleId = a.id JOIN topics t ON t.id = at.topicId
        WHERE ${eligibleDates.join(' AND ')}
        ${options.topic ? 'AND t.slug = ?' : ''}
    ), ranked_topic AS MATERIALIZED (
        SELECT p.sourceId, p.rankingKey, p.canonicalUrl, p.capturedAt, ast.topicId, ast.slug, ast.label
        FROM period_records p JOIN association_topics ast ON ast.sourceId = p.sourceId AND ast.canonicalUrl = p.canonicalUrl
        ${options.topic ? 'WHERE ast.slug = ?' : ''}
    ), ranked_eligible AS MATERIALIZED (
        SELECT DISTINCT sourceId, rankingKey, canonicalUrl FROM ranked_topic
    ), topic_denominators AS (
        SELECT e.topicId, c.rankingKey, COUNT(DISTINCT e.canonicalUrl) AS eligibleArticles,
            COUNT(DISTINCT CASE WHEN r.canonicalUrl IS NOT NULL THEN e.canonicalUrl END) AS eligibleRankedArticles,
            COUNT(DISTINCT e.sourceId) AS coveredPublishers
        FROM eligible_articles e JOIN coverage c ON c.sourceId = e.sourceId
        LEFT JOIN ranked_eligible r ON r.sourceId = e.sourceId AND r.rankingKey = c.rankingKey AND r.canonicalUrl = e.canonicalUrl
        GROUP BY e.topicId, c.rankingKey
    ), topic_counts AS (
        SELECT topicId, slug, label, rankingKey, COUNT(DISTINCT canonicalUrl) AS rankedArticles,
            COUNT(*) AS appearances FROM ranked_topic GROUP BY topicId, rankingKey
    ), topic_keys AS (
        SELECT topicId, rankingKey FROM topic_counts UNION SELECT topicId, rankingKey FROM topic_denominators
    ) SELECT
        (SELECT COUNT(DISTINCT canonicalUrl) FROM period_records) AS uniqueRankedArticles,
        (SELECT COUNT(*) FROM first_seen WHERE ${options.startAt ? 'julianday(firstCaptured) >= julianday(?)' : '1 = 1'}) AS newEntries,
        (SELECT COUNT(DISTINCT canonicalUrl) FROM period_records WHERE rank = 1) AS numberOneArticles,
        (SELECT COUNT(*) FROM period_snapshots) AS snapshots,
        (SELECT COUNT(DISTINCT sourceId) FROM period_snapshots) AS publishers,
        (SELECT COUNT(*) FROM performance) AS total,
        (SELECT COUNT(*) FROM topic_keys) AS topicPerformanceTotal,
        (SELECT json_group_array(${performanceObject}) FROM (
            SELECT ${performanceColumns} FROM performance ORDER BY ${sort} ${direction}, sourceId, rankingKey, canonicalUrl LIMIT ? OFFSET ?
        )) AS topPerformers,
        (SELECT json_group_array(${performanceObject}) FROM (
            SELECT ${performanceColumns} FROM performance ORDER BY snapshotAppearances DESC, firstCaptured, sourceId, rankingKey, canonicalUrl LIMIT ?
        )) AS longestRunning,
        (SELECT json_group_array(json_object('id', id, 'name', name, 'snapshots', snapshots, 'uniqueArticles', uniqueArticles, 'rankingKeys', json(rankingKeys))) FROM (
            SELECT s.id, s.name, (SELECT COUNT(*) FROM period_snapshots ps WHERE ps.sourceId = s.id) AS snapshots,
                (SELECT COUNT(DISTINCT canonicalUrl) FROM period_records p WHERE p.sourceId = s.id) AS uniqueArticles,
                (SELECT json_group_array(rankingKey) FROM (SELECT DISTINCT rankingKey FROM period_snapshots ps WHERE ps.sourceId = s.id ORDER BY rankingKey)) AS rankingKeys
            FROM sources s WHERE EXISTS (SELECT 1 FROM period_snapshots ps WHERE ps.sourceId = s.id) ORDER BY s.name COLLATE NOCASE, s.id
        )) AS publisherRows,
        ${MOVEMENT_TYPES.map(status => `(SELECT json_group_array(${movementObject}) FROM (
            SELECT * FROM movements WHERE status = '${status}' ORDER BY ABS(change) DESC, currentRank, previousRank, sourceId, rankingKey, canonicalUrl LIMIT ?
        )) AS ${status}Rows`).join(',\n')},
        (SELECT json_group_array(json_object('status', status, 'count', count)) FROM (
            SELECT status, COUNT(*) AS count FROM movements GROUP BY status
        )) AS movementCounts,
        (SELECT json_group_array(json_object('topicId', topicId, 'slug', slug, 'label', label, 'rankingKey', rankingKey,
            'rankedArticles', rankedArticles, 'appearances', appearances, 'eligibleArticles', eligibleArticles,
            'eligibleRankedArticles', eligibleRankedArticles, 'coveredPublishers', coveredPublishers)) FROM (
            SELECT k.topicId, t.slug, t.label, k.rankingKey, COALESCE(c.rankedArticles, 0) AS rankedArticles,
                COALESCE(c.appearances, 0) AS appearances, COALESCE(d.eligibleArticles, 0) AS eligibleArticles,
                COALESCE(d.eligibleRankedArticles, 0) AS eligibleRankedArticles, COALESCE(d.coveredPublishers, 0) AS coveredPublishers
            FROM topic_keys k JOIN topics t ON t.id = k.topicId
            LEFT JOIN topic_counts c ON c.topicId = k.topicId AND c.rankingKey = k.rankingKey
            LEFT JOIN topic_denominators d ON d.topicId = k.topicId AND d.rankingKey = k.rankingKey
            ORDER BY rankedArticles DESC, t.label COLLATE NOCASE, k.rankingKey LIMIT ?
        )) AS topicPerformance`, [
        ...scope.params, ...scope.startParams, ...eligibleParams,
        ...(options.topic ? [options.topic, options.topic] : []), ...scope.startParams,
        limit, offset, limit, ...Array(6).fill(limit), limit,
    ]);
    const movements = {};
    const counts = Object.fromEntries(MOVEMENT_TYPES.map(status => [status, 0]));
    for (const { status, count } of decode(row.movementCounts)) counts[status] = count;
    for (const status of MOVEMENT_TYPES) movements[status] = decode(row[`${status}Rows`]);
    movements.counts = counts;
    const topPerformers = decode(row.topPerformers).map(withSpan);
    const longestRunning = decode(row.longestRunning).map(withSpan);
    const topicPerformance = decode(row.topicPerformance).map(topic => ({ ...topic, share: topic.eligibleArticles ? topic.eligibleRankedArticles / topic.eligibleArticles : null }));
    return {
        filters: options,
        metrics: Object.fromEntries(['uniqueRankedArticles', 'newEntries', 'numberOneArticles', 'snapshots', 'publishers'].map(key => [key, row[key]])),
        publishers: decode(row.publisherRows), rankingTypes: RANKING_TYPES,
        topPerformers, longestRunning, movements, topicPerformance,
        pagination: { limit, offset, total: row.total, hasMore: offset + limit < row.total },
        coverage: {
            longestRunning: { returned: longestRunning.length, total: row.total, truncated: longestRunning.length < row.total },
            topicPerformance: { returned: topicPerformance.length, total: row.topicPerformanceTotal, truncated: topicPerformance.length < row.topicPerformanceTotal },
        },
        methodology: METHODOLOGY,
    };
}

/** Page actual capture timestamps, retaining null observations and separate ranking types. */
export async function readAnalyticsRankingHistory(database, options) {
    const canonicalUrl = cleanHttpUrl(options.url);
    const sourceId = options.sourceId;
    const limit = Math.min(1_000, Math.max(1, options.historyLimit || 1_000));
    const offset = Math.max(0, options.offset || 0);
    if (!canonicalUrl || !sourceId) return { article: null, series: [], pagination: { limit, offset, total: 0, hasMore: false }, methodology: METHODOLOGY };
    // The source is explicit; the global publisher filter may additionally exclude it.
    const scopedOptions = { ...options, publisherId: options.publisherId ?? sourceId };
    const scope = createScope(scopedOptions);
    const result = await database.get(`${scope.sql}, article_types AS MATERIALIZED (
        SELECT DISTINCT rankingKey FROM eligible_history WHERE sourceId = ? AND canonicalUrl = ?
    ), capture_points AS MATERIALIZED (
        SELECT ps.sourceId, ps.rankingKey, ps.capturedAt, h.rank
        FROM period_snapshots ps JOIN article_types t ON t.rankingKey = ps.rankingKey
        LEFT JOIN eligible_history h ON h.sourceId = ps.sourceId AND h.rankingKey = ps.rankingKey
            AND h.capturedAt = ps.capturedAt AND h.canonicalUrl = ?
        WHERE ps.sourceId = ?
    ), point_page AS (
        SELECT * FROM capture_points ORDER BY capturedAt DESC, rankingKey LIMIT ? OFFSET ?
    ), history_stats AS (
        SELECT rankingKey, MIN(rank) AS bestRank, MIN(capturedAt) AS firstCaptured, MAX(capturedAt) AS lastCaptured,
            COUNT(DISTINCT capturedAt) AS snapshotAppearances,
            (SELECT h.rank FROM period_records h WHERE h.sourceId = ? AND h.canonicalUrl = ? AND h.rankingKey = p.rankingKey ORDER BY capturedAt DESC LIMIT 1) AS latestRank
        FROM period_records p WHERE sourceId = ? AND canonicalUrl = ? GROUP BY rankingKey
    ) SELECT
        (SELECT json_object('sourceId', h.sourceId, 'sourceName', s.name, 'canonicalUrl', h.canonicalUrl,
            'title', COALESCE(h.title, a.title, h.canonicalUrl), 'articleId', h.localArticleId)
            FROM eligible_history h JOIN sources s ON s.id = h.sourceId LEFT JOIN articles a ON a.id = h.localArticleId
            WHERE h.sourceId = ? AND h.canonicalUrl = ? ORDER BY h.capturedAt DESC, h.id DESC LIMIT 1) AS article,
        (SELECT COUNT(*) FROM capture_points) AS total,
        (SELECT json_group_array(json_object('rankingKey', rankingKey, 'capturedAt', capturedAt, 'rank', rank)) FROM (
            SELECT * FROM point_page ORDER BY capturedAt, rankingKey
        )) AS points,
        (SELECT json_group_array(json_object('rankingKey', rankingKey, 'bestRank', bestRank, 'latestRank', latestRank,
            'firstCaptured', firstCaptured, 'lastCaptured', lastCaptured, 'snapshotAppearances', snapshotAppearances)) FROM history_stats) AS statistics`, [
        ...scope.params, sourceId, canonicalUrl, canonicalUrl, sourceId, limit, offset,
        sourceId, canonicalUrl, sourceId, canonicalUrl, sourceId, canonicalUrl,
    ]);
    const points = decode(result.points);
    const statistics = decode(result.statistics);
    const keys = [...new Set([...statistics.map(row => row.rankingKey), ...points.map(row => row.rankingKey)])];
    return {
        article: result.article ? JSON.parse(result.article) : null,
        series: keys.map(rankingKey => ({ rankingKey, label: RANKING_TYPES.find(type => type.key === rankingKey)?.label || rankingKey,
            points: points.filter(point => point.rankingKey === rankingKey).map(({ capturedAt, rank }) => ({ capturedAt, rank })),
            statistics: statistics.find(row => row.rankingKey === rankingKey) ? withSpan(statistics.find(row => row.rankingKey === rankingKey)) : null,
        })),
        pagination: { limit, offset, total: result.total, hasMore: offset + limit < result.total },
        methodology: METHODOLOGY,
    };
}
