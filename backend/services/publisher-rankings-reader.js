import { cleanHttpUrl } from '../utils/url.js';
import { readMostReadRankings } from './most-read-reader.js';
import { readRankingRefreshStatus } from './ranking-status.js';
import { RANKING_MEDIA } from './ranking-media.js';
export { RANKING_MEDIA } from './ranking-media.js';

export async function readPublisherRankingsPayload(medium, database) {
    const publisher = RANKING_MEDIA.find(item => item.id === medium);
    if (!publisher) throw new Error('Unsupported ranking medium');
    const sources = await database.all(`SELECT sources.id, sources.websiteUrl,
        EXISTS (SELECT 1 FROM feeds WHERE feeds.sourceId = sources.id
            AND (feedUrl LIKE 'https://%' OR feedUrl LIKE 'http://%')) AS hasRss FROM sources`);
    const allowed = sources.filter(source => {
        const url = cleanHttpUrl(source.websiteUrl);
        return url && new URL(url).hostname.toLowerCase().replace(/^www\./, '') === publisher.hostname;
    });
    const ids = new Set(allowed.map(source => Number(source.id)));
    return {
        medium,
        media: RANKING_MEDIA.map(({ id, name }) => ({ id, name })),
        configured: allowed.some(source => Boolean(source.hasRss)),
        rankings: (await readMostReadRankings(database, { respectDigestExclusions: false })).filter(group => ids.has(group.sourceId)),
        rankingStatus: await readRankingRefreshStatus(database, medium),
    };
}
