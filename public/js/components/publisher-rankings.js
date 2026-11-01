import { formatDate } from '../utils/format.js';
import { createArticleCard } from './article-card.js';

const rankingLabels = { most_read: 'Most read', most_commented: 'Most commented', top_news: 'Top-News' };
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const topRowFingerprints = new WeakMap();

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

function rankingLabel(group) {
    const providerLabel = ['top_news', 'most_read'].includes(group.rankingKey) && typeof group.label === 'string'
        ? group.label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').trim().slice(0, 80) : '';
    return providerLabel || rankingLabels[group.rankingKey];
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
            label: rankingLabel(group),
            capturedAt: group.capturedAt && Number.isFinite(captured.getTime()) ? captured.toISOString() : null,
            items,
        }];
    }).sort((left, right) => Number(left.rankingKey === 'most_commented') - Number(right.rankingKey === 'most_commented'));
}

export function normalizeTopArticles(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).flatMap(item => {
        const canonicalUrl = rankingUrl(item?.canonicalUrl || item?.url);
        if (!canonicalUrl || seen.has(canonicalUrl)) return [];
        seen.add(canonicalUrl);
        const rankings = (Array.isArray(item.rankings) ? item.rankings : []).flatMap(group => {
            if (!group || !Object.hasOwn(rankingLabels, group.rankingKey) || !positiveId(group.rank)) return [];
            return [{ ...group, rank: positiveId(group.rank), label: rankingLabel(group) }];
        });
        return [{ ...item, id: positiveId(item.id), canonicalUrl, url: rankingUrl(item.url) || canonicalUrl, rankings }];
    });
}

export function renderTopArticles(container, items, articleMap, { status, configured, media = [], template = document.getElementById('article-card-template') } = {}) {
    const articles = normalizeTopArticles(items);
    let list = container.querySelector('.publisher-top-list');
    if (!list) {
        container.replaceChildren();
        list = document.createElement('ul');
        list.className = 'publisher-top-list cards';
        const state = document.createElement('p');
        state.className = 'publisher-rankings-status oj-muted';
        state.setAttribute('role', 'status');
        state.setAttribute('aria-live', 'polite');
        container.append(state, list);
    }
    container.hidden = false;
    const state = container.querySelector('.publisher-rankings-status');
    state.classList.toggle('is-error', status?.state === 'error');
    state.textContent = articles.length ? '' : configured === false ? 'Add a supported RSS feed in Settings.'
        : status?.state === 'loading' ? 'Loading…' : status?.state === 'refreshing' ? 'Refreshing…'
            : status?.state === 'error' ? 'Could not load articles. Retry refresh.' : 'No articles yet. Select Refresh.';
    state.hidden = !state.textContent;
    const existing = new Map([...list.children].map(row => [row.dataset.itemUrl, row]));
    const retained = new Set();
    articles.forEach((article, index) => {
        if (article.id) articleMap.set(article.id, article);
        const fingerprint = JSON.stringify({ ...article, content: undefined });
        let row = existing.get(article.canonicalUrl);
        if (!row || topRowFingerprints.get(row) !== fingerprint) {
            const replacement = document.createElement('li');
            replacement.dataset.itemUrl = article.canonicalUrl;
            topRowFingerprints.set(replacement, fingerprint);
            const fragment = createArticleCard(article, template);
            const card = fragment.querySelector('.feed-card');
            card.classList.add('publisher-ranking-card');
            card.dataset.itemUrl = article.canonicalUrl;
            if (!article.teaser) card.querySelector('.teaser').hidden = true;
            if (!article.id) {
                card.removeAttribute('data-article-id');
                card.querySelector('.meta-source').disabled = true;
                card.querySelector('.meta-source').removeAttribute('data-action');
                card.querySelector('.meta-date').hidden = !article.publishedAt;
                card.querySelector('.meta-separator').hidden = !article.publishedAt;
                card.querySelector('.btn-open-external').disabled = false;
                for (const action of card.querySelectorAll('.article-save-btn, .article-dismiss-btn')) action.title = 'Available when this article is in your RSS feeds';
            }
            const provenance = document.createElement('div');
            provenance.className = 'publisher-ranking-provenances';
            for (const ranking of article.rankings) {
                const chip = document.createElement('span');
                chip.className = 'publisher-ranking-provenance oj-badge';
                const publisher = media.find(item => item.id === ranking.medium)?.name || ranking.medium || article.sourceName;
                chip.textContent = `${publisher} · ${ranking.label} #${ranking.rank}`;
                if (ranking.capturedAt) chip.title = `Captured ${ranking.capturedAt}`;
                provenance.appendChild(chip);
            }
            card.querySelector('.content').appendChild(provenance);
            replacement.appendChild(fragment);
            if (row) row.replaceWith(replacement);
            row = replacement;
        }
        retained.add(row);
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
    for (const row of [...list.children]) if (!retained.has(row)) row.remove();
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
