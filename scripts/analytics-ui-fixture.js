// Deterministic synthetic records used only by the isolated Analytics browser test.
export async function seedAnalyticsUiFixture(db) {
    const { DEFAULT_FEEDS_MARKER } = await import('./default-feeds.js');
    const { DEFAULT_BULLSHIT_RULES_MARKER } = await import('./default-bullshit-rules.js');
    const { ensureTopicDefinitionsInitialized } = await import('../backend/services/topics.js');
    await db.initSchema();
    for (const marker of [DEFAULT_FEEDS_MARKER, DEFAULT_BULLSHIT_RULES_MARKER]) await db.run("INSERT INTO app_metadata (key,value,updatedAt) VALUES (?, '1', datetime('now'))", [marker]);
    await ensureTopicDefinitionsInitialized();
    const now = Date.now();
    const day = 86_400_000;
    const at = days => new Date(now - days * day).toISOString();
    await db.transaction(async () => {
        for (const [id, name, website] of [[1, 'Golem', 'https://www.golem.de/'], [2, 'The Verge', 'https://www.theverge.com/'], [3, 'Independent publisher', 'https://independent.example/']]) {
            await db.run('INSERT INTO sources (id,name,websiteUrl,canonicalWebsiteUrl,createdAt,updatedAt) VALUES (?,?,?,?,?,?)', [id, name, website, website, at(90), at(1)]);
        }
        for (const [id, publisher, name, url] of [[1, 1, 'Golem Technology', 'https://rss.golem.de/rss.php?feed=RSS2.0'], [2, 1, 'Golem AI', 'https://rss.golem.de/ai.xml'], [3, 2, 'The Verge', 'https://www.theverge.com/rss/index.xml'], [4, 3, 'Independent RSS', 'https://independent.example/feed']]) {
            await db.run('INSERT INTO feeds (id,sourceId,name,feedUrl,createdAt,updatedAt) VALUES (?,?,?,?,?,?)', [id, publisher, name, url, at(90), at(1)]);
        }
        for (const [id, slug, label] of [[901, 'analytics-ai', 'Artificial intelligence'], [902, 'analytics-security', 'Security']]) {
            await db.run("INSERT INTO topics (id,slug,label,configJson,ruleHash,ruleVersion,createdAt,updatedAt) VALUES (?,?,?,?,'fixture',1,?,?)", [id, slug, label, JSON.stringify({ label, strong: [label.toLowerCase()] }), at(90), at(1)]);
        }
        for (let id = 1; id <= 24; id += 1) {
            const feedId = id <= 12 ? 1 : id <= 16 ? 2 : id <= 20 ? 3 : 4;
            const title = ['Open models and the changing AI ecosystem', 'Security researchers inspect browser extensions', 'How publishers cover technology this week', 'A new approach to local language models'][id % 4];
            const url = id === 16 ? 'https://www.golem.de/news/analytics-1.html' : feedId <= 2 ? `https://www.golem.de/news/analytics-${id}.html` : `https://independent.example/articles/${id}`;
            const published = at(id === 24 ? 45 : (id % 12) + 0.25);
            await db.run(`INSERT INTO articles (id,feedId,externalId,title,teaser,content,url,canonicalUrl,contentHash,publishedAt,fetchedAt,createdAt,updatedAt,classificationStatus)
                VALUES (?,?,?,?,?,'Isolated browser fixture article.',?,?,'fixture',?,?,?,? ,?)`,
            [id, feedId, `analytics-${id}`, `${title} ${id}`, 'Stored article metadata for the Analytics browser fixture.', url, url, published, at(id % 7 + 0.1), published, at(0), id % 8 === 0 ? 'pending' : 'ready']);
            if (id % 8 !== 0) await db.run("INSERT INTO article_topics (articleId,topicId,score,classificationVersion,createdAt) VALUES (?,?,10,'fixture',?)", [id, id % 3 === 0 ? 902 : 901, at(1)]);
            if (id % 4 === 0) await db.run("INSERT OR IGNORE INTO article_topics (articleId,topicId,score,classificationVersion,createdAt) VALUES (?,902,10,'fixture',?)", [id, at(1)]);
            if (id <= 5) await db.run('INSERT INTO article_state (articleId,readAt,dismissedAt,createdAt,updatedAt) VALUES (?,?,?,?,?)', [id, id <= 3 ? at(0.5) : null, id === 5 ? at(0.5) : null, at(1), at(0)]);
        }
        await db.run("INSERT INTO lists (id,name,createdAt,updatedAt) VALUES (1,'Analytics reading list',?,?)", [at(30), at(0)]);
        await db.run('INSERT INTO list_items (listId,articleId,createdAt) VALUES (1,1,?),(1,2,?)', [at(0), at(0)]);
        await db.run("INSERT INTO bullshit_rules (id,name,enabled,field,operator,value,createdAt,updatedAt) VALUES (901,'Sponsored fixture',1,'title','contains','Sponsored',?,?)", [at(90), at(0)]);
        await db.run('INSERT INTO article_bullshit_matches (articleId,ruleId,matchedAt) VALUES (2,901,?),(6,901,?)', [at(0), at(0)]);
        for (const [age, entries] of [[5, [[1, 8], [2, 2], [3, 5], [4, 7]]], [2, [[1, 8], [2, 2], [3, 5]]], [1, [[1, 3], [2, 6], [4, 4], [0, 1]]]]) {
            for (const [articleId, rank] of entries) await db.run('INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (1,?,?,?,?,?,?)',
                [articleId || null, `https://www.golem.de/news/analytics-${articleId || 'external'}.html`, articleId ? `Observed technology story ${articleId}` : 'Publisher selection outside subscribed feeds', rank, 'most_read', at(age)]);
        }
        for (const age of [4, 1]) {
            await db.run("INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (1,1,'https://www.golem.de/news/analytics-1.html','Observed technology story 1',1,'most_commented',?)", [at(age)]);
            await db.run("INSERT INTO most_read (sourceId,articleId,canonicalUrl,title,rank,rankingKey,capturedAt) VALUES (2,17,'https://independent.example/articles/17','Editorial selection about technology',1,'top_news',?)", [at(age)]);
        }
    });
}
