import { get } from '../database/datenbank.js';

export async function getStatistics() {
    // One statement keeps all counts in the same SQLite read snapshot.
    const row = await get(`SELECT
        (SELECT COUNT(*) FROM articles) AS totalArticles,
        (SELECT COUNT(DISTINCT articleId) FROM article_bullshit_matches) AS bullshitArticles,
        (SELECT json_group_array(json_object('id', id, 'name', name, 'count', articleCount)) FROM (
            SELECT feeds.id, COALESCE(NULLIF(feeds.name, ''), sources.name) AS name, COUNT(*) AS articleCount
            FROM articles JOIN feeds ON feeds.id = articles.feedId JOIN sources ON sources.id = feeds.sourceId
            GROUP BY feeds.id
            ORDER BY articleCount DESC, name COLLATE NOCASE ASC, feeds.id ASC LIMIT 10
        )) AS topFeeds,
        (SELECT json_group_array(json_object('id', id, 'name', name, 'count', articleCount)) FROM (
            SELECT topics.id, topics.label AS name, COUNT(*) AS articleCount
            FROM article_topics JOIN topics ON topics.id = article_topics.topicId
            GROUP BY topics.id
            ORDER BY articleCount DESC, name COLLATE NOCASE ASC, topics.id ASC LIMIT 10
        )) AS topTopics`);
    return {
        totalArticles: Number(row.totalArticles),
        bullshitArticles: Number(row.bullshitArticles),
        topFeeds: JSON.parse(row.topFeeds),
        topTopics: JSON.parse(row.topTopics),
    };
}
