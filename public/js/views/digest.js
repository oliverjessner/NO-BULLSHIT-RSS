import { api } from '../api/client.js';
import { createDigestCluster } from '../components/digest-cluster.js';
import { CONFIG, STORAGE_KEYS } from '../config.js';
import { closeViewer, isViewerOpen, openArticle, openExternal } from '../services/article-viewer.js';
import { store } from '../state/store.js';
import { dom } from '../ui/dom.js';
import { bindExportMenu } from '../ui/export-menu.js';
import { openListModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { isAbortError, normalizeIds } from '../utils/data.js';
import { clear, hide, setPressed, show, text } from '../utils/dom.js';
import { createDigestExport, downloadExport } from '../utils/export.js';
import { applySourceFilter, applyTopicFilter } from './feed.js';

let initialized = false;
let renderQueue = [];
let sentinel = null;
let observer = null;

const rangeLabel = range => range === 'month' ? 'Month' : range === 'week' ? 'Week' : 'Day';
const emptyLabel = range => range === 'month' ? 'No articles have been saved for this month yet.' : range === 'week' ? 'No articles have been saved for this week yet.' : 'No articles have been saved for today yet.';
const clusterTime = cluster => { const value = new Date(cluster?.representative?.publishedAt || cluster?.items?.[0]?.publishedAt).getTime(); return Number.isFinite(value) ? value : 0; };

function sortedClusters(payload) {
    const direction = store.ui.digestSort === 'asc' ? 1 : -1;
    return [...(payload?.clusters || [])].sort((a, b) => direction * (clusterTime(a) - clusterTime(b)));
}

function fingerprint(payload) {
    return [payload?.variant, payload?.totalArticles, payload?.totalClusters, ...(payload?.clusters || []).map(cluster => `${cluster?.representative?.id}:${cluster?.clusterCount}:${cluster?.representative?.publishedAt}`)].join('|');
}

function updateControls() {
    setPressed(dom.digest.rangeOptions, item => item.dataset.digestRange === store.ui.digestRange);
    setPressed(dom.digest.sortOptions, item => item.dataset.digestSort === store.ui.digestSort);
    const ids = normalizeIds((store.digest.payload?.clusters || []).flatMap(cluster => (cluster.items || []).map(item => item.id)));
    dom.digest.markAll.disabled = ids.length === 0;
    text(dom.digest.markAll, ids.length ? `Mark visible as digested (${ids.length})` : 'Mark visible as digested');
}

function setRangeLoading(loading) {
    dom.digest.rangeOptions.forEach(option => {
        option.disabled = Boolean(loading);
    });
    dom.digest.range.setAttribute('aria-disabled', String(Boolean(loading)));
    dom.digest.range.setAttribute('aria-busy', String(Boolean(loading)));
}

function renderSubtitle(payload) {
    const status = payload?.status === 'building' || payload?.stale ? ' · Rebuilding' : payload?.status === 'closed' ? ' · Closed' : '';
    text(dom.digest.subtitle, `${rangeLabel(payload?.variant || store.ui.digestRange)} · ${Number(payload?.totalClusters || 0).toLocaleString('en-US')} stories · ${Number(payload?.totalArticles || 0).toLocaleString('en-US')} sources${status}`);
}

function ensureSentinel() {
    if (!sentinel) {
        sentinel = document.createElement('div'); sentinel.className = 'digest-render-sentinel'; sentinel.setAttribute('aria-hidden', 'true');
        if ('IntersectionObserver' in window) {
            observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) renderNextBatch(); }, { rootMargin: '600px 0px' });
            observer.observe(sentinel);
        }
    }
    return sentinel;
}

function renderNextBatch() {
    if (store.digest.renderedCount >= renderQueue.length) { sentinel?.remove(); return; }
    const end = Math.min(renderQueue.length, store.digest.renderedCount + CONFIG.DIGEST_RENDER_BATCH_SIZE);
    const fragment = document.createDocumentFragment();
    for (let index = store.digest.renderedCount; index < end; index += 1) fragment.appendChild(createDigestCluster(renderQueue[index], dom.digest.template, store.digest.articlesById, dom.feed.topicFilter.value));
    store.digest.renderedCount = end;
    if (sentinel?.isConnected) dom.digest.list.insertBefore(fragment, sentinel); else dom.digest.list.appendChild(fragment);
    if (end < renderQueue.length) dom.digest.list.appendChild(ensureSentinel()); else sentinel?.remove();
}

function render(payload, { force = false } = {}) {
    const nextFingerprint = fingerprint(payload);
    if (!force && nextFingerprint === store.digest.fingerprint) return;
    store.digest.fingerprint = nextFingerprint;
    store.digest.articlesById = new Map(); store.digest.renderedCount = 0;
    renderQueue = sortedClusters(payload); clear(dom.digest.list);
    renderSubtitle(payload); updateControls();
    if (!renderQueue.length) { text(dom.digest.state, emptyLabel(payload?.variant || store.ui.digestRange)); show(dom.digest.state); return; }
    text(dom.digest.state, ''); hide(dom.digest.state); renderNextBatch();
}

export async function loadDigest({ force = false, silent = false } = {}) {
    const requestedRange = store.ui.digestRange;
    if (!force && !store.digest.needsRefresh && store.digest.payload?.variant === requestedRange) return;
    store.digest.requestController?.abort();
    const controller = new AbortController(); const requestId = ++store.digest.requestId;
    store.digest.requestController = controller;
    const isRangeSwitch = store.digest.payload && store.digest.payload.variant !== requestedRange;
    if (!silent && (!store.digest.payload || isRangeSwitch)) {
        clear(dom.digest.list);
        text(dom.digest.state, `Loading ${rangeLabel(requestedRange).toLowerCase()}…`);
        text(dom.digest.subtitle, `${rangeLabel(requestedRange)} · Loading…`);
        show(dom.digest.state);
    }
    if (isRangeSwitch) setRangeLoading(true);
    try {
        const payload = await api.digest(requestedRange, controller.signal);
        if (requestId !== store.digest.requestId || store.ui.digestRange !== requestedRange) return;
        const responseRange = payload?.variant || requestedRange;
        if (responseRange !== requestedRange) throw new Error(`Expected ${requestedRange} digest, received ${responseRange}`);
        store.digest.payload = { ...payload, variant: responseRange };
        store.digest.needsRefresh = false; render(store.digest.payload, { force });
    } catch (error) {
        if (isAbortError(error) || requestId !== store.digest.requestId) return;
        text(dom.digest.state, `Error: ${error.message}`); show(dom.digest.state); text(dom.digest.subtitle, 'Failed to load digest.');
    } finally {
        if (store.digest.requestController === controller) store.digest.requestController = null;
        if (requestId === store.digest.requestId) setRangeLoading(false);
    }
}

async function markDigested(ids, button, { removeCluster = false } = {}) {
    const normalized = normalizeIds(ids); if (!normalized.length) return;
    const mutationRange = store.ui.digestRange;
    const previous = button ? [...button.childNodes].map(node => node.cloneNode(true)) : [];
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Marking…'; }
    try {
        store.digest.pendingMutationEvents += 1;
        await api.markDigested(normalized, mutationRange);
        if (removeCluster) {
            const set = new Set(normalized);
            store.digest.payload.clusters = store.digest.payload.clusters.filter(cluster => !(cluster.items || []).some(item => set.has(Number(item.id))));
            store.digest.payload.totalClusters = store.digest.payload.clusters.length;
            store.digest.payload.totalArticles = store.digest.payload.clusters.reduce((sum, cluster) => sum + (cluster.items || []).length, 0);
            render(store.digest.payload, { force: true });
        } else { store.digest.needsRefresh = true; await loadDigest({ force: true }); }
        toast.success(`${normalized.length === 1 ? 'Story' : `${normalized.length} sources`} marked as digested`, { actionLabel: 'Undo', onAction: async () => { await api.restoreDigested(normalized, mutationRange); store.digest.needsRefresh = true; await loadDigest({ force: true }); } });
    } catch (error) {
        store.digest.pendingMutationEvents = Math.max(0, store.digest.pendingMutationEvents - 1);
        if (button) { button.disabled = false; button.replaceChildren(...previous); }
        toast.error(`Digested failed: ${error.message}`);
    } finally {
        button?.removeAttribute('aria-busy');
    }
}

async function exportDigest(format) {
    try {
        if (!store.digest.payload || store.digest.payload.variant !== store.ui.digestRange) {
            await loadDigest({ force: true });
        }
        const payload = store.digest.payload;
        if (!payload || payload.variant !== store.ui.digestRange) throw new Error('The selected digest is not available.');
        const clusters = sortedClusters(payload);
        const artifact = createDigestExport(format, { variant: payload.variant, clusters });
        downloadExport(artifact);
        toast.success(`Exported ${clusters.length.toLocaleString('en-US')} ${clusters.length === 1 ? 'story' : 'stories'}.`);
    } catch (error) {
        toast.error(`Export failed: ${error.message}`);
    }
}

function bindEvents() {
    bindExportMenu({
        root: dom.digest.exportMenu,
        trigger: dom.digest.exportTrigger,
        popover: dom.digest.exportPopover,
        onSelect: exportDigest,
    });
    dom.digest.range.addEventListener('click', async event => {
        const option = event.target.closest('[data-digest-range]'); if (!option || option.dataset.digestRange === store.ui.digestRange) return;
        store.ui.digestRange = option.dataset.digestRange; localStorage.setItem(STORAGE_KEYS.digestRange, store.ui.digestRange); updateControls(); store.digest.needsRefresh = true; await loadDigest({ force: true });
    });
    dom.digest.sort.addEventListener('click', event => {
        const option = event.target.closest('[data-digest-sort]'); if (!option || option.dataset.digestSort === store.ui.digestSort) return;
        store.ui.digestSort = option.dataset.digestSort; localStorage.setItem(STORAGE_KEYS.digestSort, store.ui.digestSort); updateControls(); if (store.digest.payload) render(store.digest.payload, { force: true });
    });
    dom.digest.markAll.addEventListener('click', () => {
        const trigger = dom.digest.bulkMenu?.querySelector('[data-oj-dropdown-trigger]');
        if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click();
        const ids = (store.digest.payload?.clusters || []).flatMap(cluster => (cluster.items || []).map(item => item.id));
        void markDigested(ids, dom.digest.markAll);
    });
    dom.digest.list.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]'); if (!action) return;
        const card = event.target.closest('.digest-item-card');
        event.preventDefault(); event.stopPropagation();
        if (action.dataset.action === 'filter-source') await applySourceFilter(action.dataset);
        else if (action.dataset.action === 'filter-topic') await applyTopicFilter(action.dataset.topicSlug, { switchView: true });
        else if (action.dataset.action === 'external') openExternal(action.dataset.articleId, action.dataset.itemUrl);
        else if (action.dataset.action === 'read' && card?.dataset.articleId) openArticle(card.dataset.articleId);
        else if (action.dataset.action === 'read' && card?.dataset.itemUrl) window.open(card.dataset.itemUrl, '_blank', 'noopener,noreferrer');
        else if (action.dataset.action === 'save') await openListModal(normalizeIds(String(action.dataset.articleIds || '').split(',')));
        else if (action.dataset.action === 'digest') await markDigested(String(action.dataset.articleIds || '').split(','), action, { removeCluster: true });
    });
    dom.digest.list.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const card = event.target.closest('.digest-item-card-link'); if (!card) return;
        if (event.target !== card) return;
        event.preventDefault(); if (card.dataset.articleId) openArticle(card.dataset.articleId); else if (card.dataset.itemUrl) window.open(card.dataset.itemUrl, '_blank', 'noopener,noreferrer');
    });
    window.addEventListener('keydown', event => {
        if (event.defaultPrevented || document.querySelector('dialog[open], [data-oj-dropdown-trigger][aria-expanded="true"]')) return;
        if (event.key === 'Escape' && store.ui.activeView === 'digest' && isViewerOpen()) { event.preventDefault(); closeViewer(); }
    });
}

export async function initDigest() {
    if (initialized) return;
    initialized = true; store.digest.initialized = true; bindEvents(); updateControls(); await loadDigest({ force: true });
}
export async function activateDigest() { if (!initialized) await initDigest(); else if (store.digest.needsRefresh) await loadDigest({ silent: true }); }
export function deactivateDigest() { store.digest.requestController?.abort(); }
export function markDigestDirty() { store.digest.needsRefresh = true; }
