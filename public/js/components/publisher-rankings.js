import { formatDate } from '../utils/format.js';
import { createArticleCard } from './article-card.js';

const rankingLabels = { most_read: 'Most read', most_commented: 'Most commented' };
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function rankingUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

export function normalizePublisherRankings(rankings) {
    return (Array.isArray(rankings) ? rankings : []).flatMap(group => {
        if (!group || !Object.hasOwn(rankingLabels, group.rankingKey)) return [];
        const items = (Array.isArray(group.items) ? group.items : []).flatMap(item => {
            if (!item) return [];
            const canonicalUrl = rankingUrl(item.canonicalUrl);
            const rank = positiveId(item.rank);
            if (!canonicalUrl || !rank) return [];
            const articleId = positiveId(item.articleId);
            const article = articleId && positiveId(item.article?.id) === articleId ? {
                ...item.article,
                id: articleId,
                url: rankingUrl(item.article.url) || canonicalUrl,
            } : null;
            return [{
                id: positiveId(item.id), rank, canonicalUrl, article,
                articleId: article?.id || null,
                title: String(item.title || article?.title || canonicalUrl),
            }];
        }).sort((left, right) => left.rank - right.rank);
        if (!items.length) return [];
        const captured = new Date(group.capturedAt);
        return [{
            sourceId: positiveId(group.sourceId),
            sourceName: String(group.sourceName || 'Unknown source'),
            rankingKey: group.rankingKey,
            label: rankingLabels[group.rankingKey],
            capturedAt: group.capturedAt && Number.isFinite(captured.getTime()) ? captured.toISOString() : null,
            items,
        }];
    }).sort((left, right) => Number(left.rankingKey === 'most_commented') - Number(right.rankingKey === 'most_commented'));
}

export function publisherRankingsFingerprint(rankings, status, configured) {
    // Snapshot identity, source names, ranks, reassociations and article content
    // can change independently of the current digest's clusters.
    return JSON.stringify({ rankings: Array.isArray(rankings) ? rankings : [], status: status || null, configured });
}

export function renderPublisherRankings(container, rankings, articleMap, { status, configured, publisherName = 'Golem', template = document.getElementById('article-card-template'), activeTopic = '' } = {}) {
    const groups = normalizePublisherRankings(rankings);
    container.replaceChildren();
    container.hidden = false;

    const state = document.createElement('p');
    state.className = 'publisher-rankings-status oj-muted';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    if (configured === false) state.textContent = `Add a ${publisherName} RSS feed in Settings.`;
    else if (status?.state === 'loading' && !groups.length) state.textContent = 'Loading…';
    else if (status?.state === 'refreshing' && !groups.length) state.textContent = 'Refreshing…';
    else if (status?.state === 'error') {
        state.classList.add('is-error');
        state.textContent = groups.length ? ''
            : status.errorCode === 'GOLEM_CONSENT_REQUIRED' ? 'Consent could not be completed. Retry refresh.' : 'Could not load rankings. Retry refresh.';
        if (status.errorCode === 'GOLEM_CONSENT_REQUIRED') state.title = "Golem's cookie consent could not be completed automatically.";
    }
    else if (!groups.length) state.textContent = status?.state === 'ready' || (Array.isArray(rankings) && rankings.length)
        ? 'No articles available.'
        : 'No rankings yet. Select Refresh.';
    state.hidden = !state.textContent;
    container.appendChild(state);
    if (!groups.length) return;
    const grid = document.createElement('div');
    grid.className = 'publisher-rankings-grid';

    for (const group of groups) {
        const panel = document.createElement('section');
        panel.className = 'publisher-ranking-panel';
        panel.dataset.rankingKey = group.rankingKey;
        const header = document.createElement('header');
        header.className = 'publisher-ranking-header';
        const title = document.createElement('h2');
        title.className = 'publisher-ranking-title oj-heading-3';
        title.textContent = group.label;
        const captured = document.createElement('time');
        captured.className = 'publisher-ranking-captured oj-muted';
        if (group.capturedAt) {
            captured.dateTime = group.capturedAt;
            captured.title = `Captured ${group.capturedAt}`;
            captured.textContent = formatDate(group.capturedAt);
        } else {
            captured.textContent = 'Capture time unavailable';
        }
        const list = document.createElement('ol');
        list.className = 'publisher-ranking-list cards';
        for (const item of group.items) {
            const row = document.createElement('li');
            row.value = item.rank;
            const article = item.article || { title: item.title, url: item.canonicalUrl, sourceName: group.sourceName, teaser: '', topics: [] };
            const fragment = createArticleCard(article, template, activeTopic);
            const card = fragment.querySelector('.feed-card');
            card.classList.add('publisher-ranking-card');
            card.dataset.itemUrl = item.canonicalUrl;
            const rank = document.createElement('span');
            rank.className = 'publisher-ranking-rank oj-mono';
            rank.textContent = `#${item.rank}`;
            rank.title = `Rank ${item.rank}`;
            card.querySelector('.meta').prepend(rank);
            if (!article.teaser) card.querySelector('.teaser').hidden = true;
            if (item.article) {
                if (!articleMap.has(item.articleId)) articleMap.set(item.articleId, item.article);
            } else {
                card.removeAttribute('data-article-id');
                card.querySelector('.meta-date').hidden = true;
                card.querySelector('.meta-separator').hidden = true;
                const source = card.querySelector('.meta-source');
                source.disabled = true;
                source.removeAttribute('data-action');
                const external = card.querySelector('.btn-open-external');
                external.disabled = false;
                external.dataset.itemUrl = item.canonicalUrl;
                for (const action of card.querySelectorAll('.article-save-btn, .article-dismiss-btn')) {
                    action.title = 'Available when this article is in your RSS feeds';
                }
            }
            row.appendChild(fragment);
            list.appendChild(row);
        }
        header.append(title, captured);
        panel.append(header, list);
        grid.appendChild(panel);
    }
    container.appendChild(grid);
}
