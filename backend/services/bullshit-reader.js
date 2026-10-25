// Keep read queries independent of the application's writable SQLite connection.
export async function loadBullshitMatchesByArticleIds(articleIds, database) {
    const ids = [...new Set((Array.isArray(articleIds) ? articleIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    const matches = new Map();
    for (let index = 0; index < ids.length; index += 400) {
        const rows = await database.all(
            `SELECT article_bullshit_matches.articleId, bullshit_rules.id, bullshit_rules.name
             FROM article_bullshit_matches
             JOIN bullshit_rules ON bullshit_rules.id = article_bullshit_matches.ruleId
             WHERE article_bullshit_matches.articleId IN (SELECT value FROM json_each(?))
             ORDER BY bullshit_rules.id ASC`,
            [JSON.stringify(ids.slice(index, index + 400))],
        );
        for (const row of rows) {
            const articleId = Number(row.articleId);
            const current = matches.get(articleId) || [];
            current.push({ id: Number(row.id), name: row.name });
            matches.set(articleId, current);
        }
    }
    return matches;
}
