export function compactArticle(article) {
    return {
        id: article.id,
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        sourceName: article.sourceName,
    };
}

const cleanTopText = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').replace(/\s+/gu, ' ').trim();

export function formatTopArticles(articles, { json = false, medium = 'all' } = {}) {
    if (json) return JSON.stringify(articles, null, 2);
    if (!articles.length) return `No saved top articles${medium === 'all' ? '' : ` for ${cleanTopText(medium)}`}. Refresh publisher selections in the app first.`;
    const labels = { most_read: 'Most read', most_commented: 'Most commented', top_news: 'Top-News' };
    return articles.map((article, index) => {
        const rankings = (article.rankings || []).map(item => {
            const label = cleanTopText(item.label || labels[item.rankingKey] || 'Publisher selection').slice(0, 80);
            return `${label} #${cleanTopText(item.rank)} · ${cleanTopText(item.capturedAt)}`;
        }).join('; ');
        return [
            `${index + 1}. ${cleanTopText(article.title) || 'Untitled'}`,
            `   ${cleanTopText(article.sourceName)} · ${article.publishedAt ? cleanTopText(article.publishedAt) : `Captured ${cleanTopText(article.capturedAt)}`}`,
            ...(rankings ? [`   ${rankings}`] : []),
            `   ${cleanTopText(article.url || article.canonicalUrl)}`,
            ...(article.teaser ? [`   ${cleanTopText(article.teaser)}`] : []),
        ].join('\n');
    }).join('\n\n');
}

export function formatChosenTopArticle(article, options = {}) {
    return options.json ? JSON.stringify(article, null, 2) : formatTopArticles([article], options);
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
