import { loadTopicsByArticleIds } from './article-queries.js';
import { getDigestPeriodDefinition, getDigestTimezone } from './digest-periods.js';

export async function loadActiveClusters(period, database) {
    if (!period?.activeGenerationId) return [];
    const sourceNameExpression = database.feedNamesAvailable === false
        ? 'sources.name'
        : "COALESCE(NULLIF(feeds.name, ''), sources.name)";
    const selectSql = [
        `SELECT digest_clusters.id AS clusterId, digest_clusters.clusterKey, digest_clusters.title AS clusterTitle,
                digest_clusters.articleCount AS clusterCount, digest_clusters.displayPosition,
                digest_cluster_articles.position, digest_cluster_articles.isRepresentative,
                articles.id, articles.feedId, articles.title, articles.teaser, articles.url, articles.publishedAt,
                articles.externalId AS guidOrHash,`,
        sourceNameExpression,
        `AS sourceName,
                sources.logo IS NOT NULL AS hasSourceLogo,
                digest_cluster_state.readAt, digest_cluster_state.dismissedAt, digest_cluster_state.completedAt
         FROM digest_clusters
         JOIN digest_cluster_articles ON digest_cluster_articles.digestClusterId = digest_clusters.id
         JOIN articles ON articles.id = digest_cluster_articles.articleId
         JOIN feeds ON feeds.id = articles.feedId
         JOIN sources ON sources.id = feeds.sourceId
         LEFT JOIN digest_cluster_state ON digest_cluster_state.digestPeriodId = ?
              AND digest_cluster_state.clusterKey = digest_clusters.clusterKey
         WHERE digest_clusters.digestGenerationId = ?
           AND digest_cluster_state.dismissedAt IS NULL AND digest_cluster_state.completedAt IS NULL
           AND NOT EXISTS (SELECT 1 FROM digest_excluded_feeds WHERE digest_excluded_feeds.feedId = articles.feedId)
           ${database.bullshitRulesAvailable === false ? '' : 'AND NOT EXISTS (SELECT 1 FROM article_bullshit_matches WHERE article_bullshit_matches.articleId = articles.id)'}
         ORDER BY digest_clusters.displayPosition, digest_cluster_articles.position`,
    ].join('\n');
    const rows = await database.all(
        selectSql,
        [period.id, period.activeGenerationId],
    );
    const topicsByArticleId = await loadTopicsByArticleIds(rows.map(row => Number(row.id)), { all: database.all });
    const clusters = new Map();
    for (const row of rows) {
        if (!clusters.has(row.clusterId)) {
            clusters.set(row.clusterId, {
                clusterKey: row.clusterKey,
                clusterTitle: row.clusterTitle,
                clusterCount: Number(row.clusterCount),
                representative: null,
                items: [],
            });
        }
        const article = {
            id: Number(row.id), feedId: Number(row.feedId), title: row.title, teaser: row.teaser, url: row.url,
            publishedAt: row.publishedAt, guidOrHash: row.guidOrHash, sourceName: row.sourceName,
            sourceLogoDataUrl: row.hasSourceLogo ? `/api/feeds/${encodeURIComponent(row.feedId)}/logo` : null,
            topics: topicsByArticleId.get(Number(row.id)) || [],
        };
        const cluster = clusters.get(row.clusterId);
        cluster.items.push(article);
        if (row.isRepresentative) cluster.representative = article;
    }
    return Array.from(clusters.values()).map(cluster => ({
        ...cluster,
        representative: cluster.representative || cluster.items[0],
        clusterTitle: cluster.representative ? cluster.clusterTitle : cluster.items[0].title || 'Untitled',
        clusterCount: cluster.items.length,
    })).filter(cluster => period.type !== 'month' || cluster.items.length > 1);
}

export async function readStoredDigestPayload(type = 'day', database, referenceDate = new Date()) {
    const definition = getDigestPeriodDefinition(type, referenceDate, getDigestTimezone());
    const period = await database.get('SELECT * FROM digest_periods WHERE type = ? AND startsAt = ?', [definition.type, definition.startsAt]);
    const clusters = period ? await loadActiveClusters(period, database) : [];
    return {
        variant: definition.type,
        periodKey: definition.periodKey,
        startIso: definition.startsAt,
        endIso: definition.endsAt,
        status: period?.status || 'missing',
        stale: Boolean(period?.dirtyAt),
        generatedAt: period?.generatedAt || null,
        algorithmVersion: period?.algorithmVersion || null,
        rulesVersion: period?.rulesVersion || null,
        totalArticles: clusters.reduce((sum, cluster) => sum + cluster.items.length, 0),
        totalClusters: clusters.length,
        clusters,
    };
}
