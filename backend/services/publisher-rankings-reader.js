import { cleanHttpUrl } from '../utils/url.js';
import { readMostReadRankings } from './most-read-reader.js';
import { readRankingRefreshStatus } from './ranking-status.js';
import { RANKING_MEDIA, rankingMediumForSource } from './ranking-media.js';
export { RANKING_MEDIA } from './ranking-media.js';

export async function readPublisherRankingsPayload(medium, database) {
    const publisher = RANKING_MEDIA.find(item => item.id === medium);
    if (!publisher) throw new Error('Unsupported ranking medium');
    const sources = await database.all(`SELECT sources.id, sources.websiteUrl, feeds.feedUrl
        FROM sources LEFT JOIN feeds ON feeds.sourceId = sources.id`);
    const allowed = sources.filter(source => rankingMediumForSource(source)?.id === publisher.id);
    const ids = new Set(allowed.map(source => Number(source.id)));
    return {
        medium,
        media: RANKING_MEDIA.map(({ id, name }) => ({ id, name })),
        configured: allowed.some(source => Boolean(cleanHttpUrl(source.feedUrl))),
        rankings: (await readMostReadRankings(database, { respectDigestExclusions: false }))
            .filter(group => ids.has(group.sourceId) && publisher.rankingKeys.includes(group.rankingKey))
            .map(group => publisher.rankingLabels?.[group.rankingKey]
                ? { ...group, label: publisher.rankingLabels[group.rankingKey] } : group),
        rankingStatus: await readRankingRefreshStatus(database, medium),
    };
}
