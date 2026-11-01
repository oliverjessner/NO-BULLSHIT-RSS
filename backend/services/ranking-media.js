import { cleanHttpUrl } from '../utils/url.js';

export const RANKING_KEYS = Object.freeze(['most_read', 'most_commented']);
export const RANKING_MEDIA = Object.freeze([
    Object.freeze({ id: 'golem', name: 'Golem', hostname: 'golem.de', rankingKeys: RANKING_KEYS }),
    Object.freeze({ id: 'winfuture', name: 'WinFuture', hostname: 'winfuture.de', rankingKeys: RANKING_KEYS }),
    Object.freeze({ id: 'computerbase', name: 'ComputerBase', hostname: 'computerbase.de', rankingKeys: Object.freeze(['most_read']) }),
    Object.freeze({ id: 'heise-ix', name: 'heise iX', hostname: 'heise.de', pathPrefix: '/ix', feedPath: '/ix/feed.xml', rankingKeys: Object.freeze(['top_news']) }),
    Object.freeze({ id: 't3n', name: 't3n', hostname: 't3n.de', rankingKeys: Object.freeze(['most_read']) }),
]);

export function rankingMediumForSource(source) {
    const url = cleanHttpUrl(source?.websiteUrl);
    if (!url) return null;
    const website = new URL(url);
    const host = website.hostname.toLowerCase().replace(/^www\./, '');
    return RANKING_MEDIA.find(medium => {
        if (medium.hostname !== host) return false;
        if (medium.pathPrefix && website.pathname !== medium.pathPrefix && !website.pathname.startsWith(`${medium.pathPrefix}/`)) return false;
        if (medium.feedPath && source.feedUrl !== undefined) {
            const feedUrl = cleanHttpUrl(source.feedUrl);
            if (!feedUrl) return false;
            const feed = new URL(feedUrl);
            if (feed.hostname.toLowerCase().replace(/^www\./, '') !== medium.hostname || feed.pathname !== medium.feedPath) return false;
        }
        return true;
    }) || null;
}
