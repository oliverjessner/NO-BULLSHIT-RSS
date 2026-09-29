import { collectTopics, createSourceChip, createTopicChip } from './chips.js';
import { formatTriageTime, normalizeArticleUrl } from '../utils/format.js';
import { clear } from '../utils/dom.js';
import { normalizeIds } from '../utils/data.js';

function createDigestItem(item, articleMap) {
    const card = document.createElement('article');
    const url = normalizeArticleUrl(item?.url);
    const id = Number(item?.id);
    const validId = Number.isInteger(id) && id > 0;
    card.className = url
        ? 'digest-item-card digest-item-card-link pf-list-card'
        : 'digest-item-card pf-list-card';
    card.dataset.itemTitle = item?.title || 'Untitled';
    card.dataset.sourceName = item?.sourceName || 'Unknown source';
    if (url) { card.dataset.itemUrl = url; card.dataset.action = 'read'; card.role = 'link'; card.tabIndex = 0; }
    if (validId) { card.dataset.articleId = String(id); articleMap.set(id, item); }

    const meta = document.createElement('div');
    meta.className = 'digest-item-card-meta';
    const sourceWrap = document.createElement('span');
    sourceWrap.className = 'digest-item-source-wrap';
    if (item?.sourceLogoDataUrl) {
        const logo = document.createElement('img'); logo.className = 'digest-item-source-logo'; logo.src = item.sourceLogoDataUrl; logo.alt = ''; sourceWrap.appendChild(logo);
    }
    const source = document.createElement('span'); source.className = 'digest-item-source'; source.textContent = item?.sourceName || '—'; sourceWrap.appendChild(source);
    const published = document.createElement('span'); published.className = 'digest-item-date'; published.textContent = formatTriageTime(item?.publishedAt);
    meta.append(sourceWrap, published);

    const content = document.createElement('div'); content.className = 'digest-item-content';
    const title = document.createElement('h4'); title.className = 'digest-item-title'; title.textContent = item?.title || 'Untitled';
    const teaser = document.createElement('p'); teaser.className = 'digest-item-teaser'; teaser.textContent = item?.teaser || item?.summary || item?.description || 'No description available.';
    content.append(title, teaser);
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn ghost pf-btn pf-btn-ghost digest-item-open-btn'; open.textContent = 'Open link ↗'; open.dataset.action = 'external'; open.disabled = !url;
    if (url) open.dataset.itemUrl = url;
    if (validId) open.dataset.articleId = String(id);
    card.append(meta, content, open);
    return card;
}

export function createDigestCluster(cluster, template, articleMap, activeTopic = '') {
    const items = Array.isArray(cluster?.items) ? cluster.items : [];
    const representative = cluster?.representative || items[0] || {};
    const fragment = template.content.cloneNode(true);
    const root = fragment.querySelector('.digest-cluster');
    const sources = new Map();
    for (const item of items) {
        const name = String(item?.sourceName || 'Unknown source');
        if (!sources.has(name)) sources.set(name, { name, logo: item?.sourceLogoDataUrl || '', feedId: item?.feedId || null });
    }
    fragment.querySelector('.digest-cluster-count').textContent = `${sources.size || 1} ${sources.size === 1 ? 'source' : 'sources'}`;
    fragment.querySelector('.digest-cluster-title').textContent = cluster?.clusterTitle || representative?.title || 'Untitled';
    const dates = items.map(item => new Date(item?.publishedAt)).filter(date => Number.isFinite(date.getTime())).sort((a, b) => a - b);
    fragment.querySelector('.digest-cluster-date').textContent = `Latest ${formatTriageTime(dates.at(-1)?.toISOString())} · First report ${formatTriageTime(dates[0]?.toISOString())}`;

    const sourceRow = fragment.querySelector('.digest-cluster-sources');
    sourceRow.classList.toggle('is-single-source', sources.size === 1);
    for (const source of sources.values()) sourceRow.appendChild(createSourceChip(source));

    const grid = fragment.querySelector('.digest-items-grid');
    clear(grid);
    grid.classList.toggle('is-single-item', items.length === 1);
    for (const item of items) grid.appendChild(createDigestItem(item, articleMap));

    const ids = normalizeIds(items.map(item => item?.id));
    const footer = document.createElement('div'); footer.className = 'digest-cluster-footer';
    const topicRow = document.createElement('div'); topicRow.className = 'digest-cluster-topics';
    for (const topic of collectTopics(items)) topicRow.appendChild(createTopicChip(topic, { digest: true, activeSlug: activeTopic }));
    const actions = document.createElement('div'); actions.className = 'digest-cluster-actions';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn ghost pf-btn pf-btn-ghost digest-cluster-add-btn'; save.textContent = 'Save story'; save.dataset.action = 'save';
    const digested = document.createElement('button'); digested.type = 'button'; digested.className = 'btn ghost pf-btn pf-btn-ghost digest-cluster-digest-btn'; digested.textContent = 'Mark as digested'; digested.dataset.action = 'digest';
    if (ids.length) { const serialized = ids.join(','); root.dataset.articleIds = serialized; save.dataset.articleIds = serialized; digested.dataset.articleIds = serialized; }
    else { save.disabled = true; digested.disabled = true; }
    actions.append(save, digested); footer.append(topicRow, actions); root.appendChild(footer);
    return fragment;
}
