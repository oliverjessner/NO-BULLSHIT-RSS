import { cleanHttpUrl } from '../utils/url.js';

export const RANKING_KEYS = Object.freeze(['most_read', 'most_commented']);
export const RANKING_MEDIA = Object.freeze([
    Object.freeze({ id: 'golem', name: 'Golem', hostname: 'golem.de', rankingKeys: RANKING_KEYS }),
    Object.freeze({ id: 'winfuture', name: 'WinFuture', hostname: 'winfuture.de', rankingKeys: RANKING_KEYS }),
    Object.freeze({ id: 'computerbase', name: 'ComputerBase', hostname: 'computerbase.de', rankingKeys: Object.freeze(['most_read']) }),
]);

export function rankingMediumForSource(source) {
    const url = cleanHttpUrl(source?.websiteUrl);
    if (!url) return null;
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return RANKING_MEDIA.find(medium => medium.hostname === host) || null;
}
