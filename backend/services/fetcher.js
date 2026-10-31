import { all } from '../database/datenbank.js';
import { ingestArticle } from './article-ingest.js';
import { ensureRebuildWindowDigestPeriods, generateDirtyDigestPeriods } from './digest-store.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { publish } from './events.js';
import { fetchRssFeed } from './rss-feed.js';
import { MANUAL_IMPORT_FEED_PREFIX } from './article-import.js';
import { refreshAllFeedLogos } from './logo.js';
import { processWatchdogArticles, dispatchWatchdogNotifications } from './watchdogs.js';
import { sendDesktopNotification } from './desktop-events.js';

let lastFetchStatus = {
    at: null,
    durationMs: null,
    totalNew: 0,
    error: null,
};

export function getLastFetchStatus() {
    return lastFetchStatus;
}

let activeFetch = null;
export function updateAllFeeds(options = {}) {
    if (!activeFetch) activeFetch = fetchFeeds(options).finally(() => { activeFetch = null; });
    return activeFetch;
}

async function fetchFeeds({ refreshLogos = refreshAllFeedLogos, notify = sendDesktopNotification } = {}) {
    const start = Date.now();
    const feeds = await all('SELECT * FROM feeds WHERE feedUrl NOT LIKE ? ORDER BY id', [`${MANUAL_IMPORT_FEED_PREFIX}%`]);
    let totalNew = 0;
    const fetchedFeedIds = [];
    let errorMessage = null;

    logInfo('Fetch run started');

    try {
        for (const feed of feeds) {
            const feedStart = Date.now();

            try {
                const parsed = await fetchRssFeed(feed.feedUrl);
                fetchedFeedIds.push(feed.id);
                let newCount = 0;
                const fetchedAt = new Date().toISOString();

                for (const item of parsed.items || []) {
                    const url = item.link || item.id || null;
                    const externalId = item.guid || item.id || url;

                    if (!externalId) {
                        continue;
                    }

                    try {
                        const result = await ingestArticle({
                            feedId: feed.id,
                            externalId,
                            title: item.title,
                            teaser: item.contentSnippet || item.summary || item.content || item.description,
                            content: item['content:encoded'] || item.content || item.summary || item.description,
                            url,
                            publishedAt: item.isoDate || item.pubDate || item.published,
                            fetchedAt,
                        });
                        if (result.inserted) newCount += 1;
                    } catch (err) {
                        logWarn('Article persistence failed', {
                            feedId: feed.id,
                            error: err.message,
                            url: feed.feedUrl,
                        });
                    }
                }

                totalNew += newCount;

                logInfo('Feed updated', { feedId: feed.id, newCount, ms: Date.now() - feedStart });
            } catch (err) {
                logError('Feed failed', {
                    feedId: feed.id,
                    error: err.message,
                    ms: Date.now() - feedStart,
                    url: feed.feedUrl,
                });
            }
        }
        try {
            await processWatchdogArticles({ fetchedFeedIds });
            await dispatchWatchdogNotifications(notify);
        } catch (error) {
            logWarn('Watchdog processing failed', { error: error.message });
        }
        await refreshLogos({ missingOnly: true });
        await ensureRebuildWindowDigestPeriods();
        await generateDirtyDigestPeriods();
    } catch (err) {
        errorMessage = err.message;
        throw err;
    } finally {
        lastFetchStatus = {
            at: new Date().toISOString(),
            durationMs: Date.now() - start,
            totalNew,
            error: errorMessage,
        };

        logInfo('Fetch run finished', { totalNew, ms: Date.now() - start });
        publish('fetch.completed', { ...lastFetchStatus });
    }
}
