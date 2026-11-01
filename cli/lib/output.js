export function compactArticle(article) {
    return {
        id: article.id,
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        sourceName: article.sourceName,
    };
}

export function formatPublisherRankings(payload, { rankingKey, json = false }) {
    const rankings = payload.rankings.filter(group => group.rankingKey === rankingKey);
    const result = { medium: payload.medium, rankingKey, configured: payload.configured, rankings };
    if (json) return JSON.stringify(result, null, 2);
    const label = { most_read: 'Most read', most_commented: 'Most commented', top_news: 'Top-News' }[rankingKey];
    const emptyLabel = { most_read: 'most-read', most_commented: 'most-commented', top_news: 'Top-News' }[rankingKey];
    if (!rankings.length) return `No saved ${emptyLabel} rankings for ${payload.medium}. Refresh rankings in the app first.`;
    const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').trim();
    return rankings.map(group => {
        const editorialLabel = rankingKey === 'top_news' && typeof group.label === 'string' ? clean(group.label).slice(0, 80) : '';
        return [
            `${clean(group.sourceName)} · ${editorialLabel || label} · ${clean(group.capturedAt)}`,
            ...group.items.map(item => `${item.rank}\t${clean(item.article?.title || item.title)}\t${clean(item.article?.url || item.canonicalUrl)}`),
        ].join('\n');
    }).join('\n\n');
}

export function formatStatistics(statistics, { json = false } = {}) {
    if (json) return JSON.stringify(statistics, null, 2);
    const count = value => Number(value).toLocaleString('en-US');
    const name = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const ranking = (title, items) => [title, ...items.map(item => `${name(item.name)}: ${count(item.count)}`), ...(items.length ? [] : ['(none)'])].join('\n');
    return [
        `Articles: ${count(statistics.totalArticles)}`,
        ranking('Top 10 Feeds', statistics.topFeeds),
        ranking('Top 10 Topics', statistics.topTopics),
        `Found Bullshit Articles: ${count(statistics.bullshitArticles)}`,
    ].join('\n\n');
}

export function formatChosenArticle(article, options = {}) {
    if (options.url || options.title) {
        return formatLastArticles([article], options);
    }
    return JSON.stringify(compactArticle(article), null, 2);
}

export function formatLastArticles(articles, { url = false, title = false } = {}) {
    if (url || title) {
        return articles
            .map(article => {
                if (url && title) {
                    return `${article.url || ''}\t${article.title || ''}`;
                }
                return String(url ? article.url || '' : article.title || '');
            })
            .join('\n');
    }

    return JSON.stringify(articles.map(compactArticle), null, 2);
}

export function formatDigest(payload, count) {
    const clusters = (Array.isArray(payload?.clusters) ? payload.clusters : []).slice(0, count).map(cluster => ({
        title: cluster.clusterTitle || cluster.representative?.title || 'Ohne Titel',
        count: Number(cluster.clusterCount || cluster.items?.length || 0),
        articles: (Array.isArray(cluster.items) ? cluster.items : []).map(article => ({
            title: article.title,
            url: article.url,
            sourceName: article.sourceName,
            publishedAt: article.publishedAt,
        })),
    }));

    return JSON.stringify(clusters, null, 2);
}

export function formatFeeds(feeds, { rssUrl = false, amount = false } = {}) {
    const normalizedFeeds = Array.isArray(feeds) ? feeds : [];
    if (amount) return String(normalizedFeeds.length);
    if (rssUrl) {
        return normalizedFeeds.map(feed => String(feed.feedUrl || '')).filter(Boolean).join('\n');
    }

    return JSON.stringify(
        normalizedFeeds.map(feed => ({
            name: feed.name,
            feedUrl: feed.feedUrl,
            websiteUrl: feed.websiteUrl,
        })),
        null,
        2,
    );
}
