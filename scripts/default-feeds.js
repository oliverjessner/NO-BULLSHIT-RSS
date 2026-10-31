import { readFile } from 'node:fs/promises';

export const DEFAULT_FEEDS_MARKER = 'defaults.feeds.production-2026-10-31';

function webUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Default feeds require HTTP(S) URLs without credentials');
    }
    return url.toString();
}

export async function seedDefaultFeeds(database, { sources } = {}) {
    const defaults = sources ?? JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'));
    return database.transaction(async () => {
        if (await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_FEEDS_MARKER])) {
            return { applied: false, sourcesAdded: 0, feedsAdded: 0 };
        }

        let sourcesAdded = 0;
        let feedsAdded = 0;
        for (const source of defaults) {
            if (!source.hasFeed || !Array.isArray(source.feeds)) continue;
            const canonicalWebsiteUrl = webUrl(source.url);
            let sourceId;
            for (const feed of source.feeds) {
                const feedUrl = webUrl(typeof feed === 'string' ? feed : feed.url);
                // A user may have renamed a feed or moved it to another source.
                if (await database.get('SELECT id FROM feeds WHERE feedUrl = ?', [feedUrl])) continue;

                if (sourceId === undefined) {
                    const result = await database.run(
                        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
                         VALUES (?, ?, ?, datetime('now'), datetime('now'))
                         ON CONFLICT(canonicalWebsiteUrl) DO NOTHING`,
                        [source.name, source.url, canonicalWebsiteUrl],
                    );
                    sourcesAdded += result.changes;
                    sourceId = (await database.get('SELECT id FROM sources WHERE canonicalWebsiteUrl = ?', [canonicalWebsiteUrl])).id;
                }
                const result = await database.run(
                    `INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
                     VALUES (?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(feedUrl) DO NOTHING`,
                    [sourceId, typeof feed === 'string' ? source.name : feed.name || source.name, feedUrl],
                );
                feedsAdded += result.changes;
            }
        }

        // Record the seed together with its inserts so failures can be retried,
        // while later deletions are respected on every subsequent app launch.
        await database.run(
            "INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, '1', datetime('now'))",
            [DEFAULT_FEEDS_MARKER],
        );
        return { applied: true, sourcesAdded, feedsAdded };
    });
}
