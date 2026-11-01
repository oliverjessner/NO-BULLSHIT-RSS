import { formatDate } from '../utils/format.js';

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
    });
}

export function publisherRankingsFingerprint(rankings, status, configured) {
    // Snapshot identity, source names, ranks, reassociations and article content
    // can change independently of the current digest's clusters.
    return JSON.stringify({ rankings: Array.isArray(rankings) ? rankings : [], status: status || null, configured });
}

export function renderPublisherRankings(container, rankings, articleMap, { status, configured } = {}) {
    const groups = normalizePublisherRankings(rankings);
    container.replaceChildren();
    container.hidden = false;

    const heading = document.createElement('h2');
    heading.className = 'publisher-rankings-title oj-heading-3';
    heading.textContent = 'Most read & most commented';
    const note = document.createElement('p');
    note.className = 'publisher-rankings-note oj-muted';
    note.textContent = "Refreshing automatically accepts Golem's cookie consent when possible.";
    const state = document.createElement('p');
    state.className = 'publisher-rankings-status oj-muted';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    // The API's diagnostic message can contain browser or network details. Keep
    // the product message stable and never expose commands or exception traces.
    if (configured === false) state.textContent = 'Add a Golem RSS feed in Settings to load publisher rankings.';
    else if (status?.state === 'loading') state.textContent = 'Loading publisher rankings…';
    else if (status?.state === 'refreshing') state.textContent = groups.length
        ? 'Refreshing publisher rankings. Showing the latest saved rankings.' : 'Refreshing publisher rankings…';
    else if (status?.state === 'error' && status?.errorCode === 'GOLEM_CONSENT_REQUIRED') state.textContent = "Golem's cookie consent could not be completed automatically. Try Refresh again, or use Set up Golem access for a manual consent or PUR choice."
        + (groups.length ? ' Showing the latest saved rankings.' : '');
    else if (status?.state === 'error') state.textContent = groups.length
        ? 'Publisher rankings could not be refreshed. Showing the latest saved rankings.'
        : 'Publisher rankings could not be refreshed. Try Refresh again.';
    else if (!groups.length) state.textContent = status?.state === 'ready' || (Array.isArray(rankings) && rankings.length)
        ? 'No publisher rankings are available.'
        : 'No publisher rankings yet. Choose Refresh to load them.';
    state.hidden = !state.textContent;
    container.append(heading, note, state);
    if (!groups.length) return;
    const grid = document.createElement('div');
    grid.className = 'publisher-rankings-grid';

    for (const group of groups) {
        const panel = document.createElement('section');
        panel.className = 'publisher-ranking-panel oj-panel oj-panel-compact';
        panel.dataset.rankingKey = group.rankingKey;
        const title = document.createElement('h3');
        title.className = 'publisher-ranking-title oj-heading-3';
        title.textContent = `${group.label} · ${group.sourceName}`;
        const captured = document.createElement('p');
        captured.className = 'publisher-ranking-captured oj-muted';
        if (group.capturedAt) {
            const time = document.createElement('time');
            time.dateTime = group.capturedAt;
            time.title = group.capturedAt;
            time.textContent = formatDate(group.capturedAt);
            captured.append(document.createTextNode('Captured '), time);
        } else {
            captured.textContent = 'Capture time unavailable';
        }
        const list = document.createElement('ol');
        list.className = 'publisher-ranking-list';
        for (const item of group.items) {
            const row = document.createElement('li');
            row.value = item.rank;
            const link = document.createElement('a');
            link.className = 'publisher-ranking-link';
            link.href = item.canonicalUrl;
            link.dataset.itemUrl = item.canonicalUrl;
            const text = document.createElement('span');
            text.textContent = item.title;
            link.appendChild(text);
            if (item.article) {
                link.dataset.articleId = String(item.articleId);
                if (!articleMap.has(item.articleId)) articleMap.set(item.articleId, item.article);
            } else {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.setAttribute('aria-label', `${item.title} (opens in browser)`);
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-arrow-up-right-from-square';
                icon.setAttribute('aria-hidden', 'true');
                link.appendChild(icon);
            }
            row.appendChild(link);
            list.appendChild(row);
        }
        panel.append(title, captured, list);
        grid.appendChild(panel);
    }
    container.appendChild(grid);
}
