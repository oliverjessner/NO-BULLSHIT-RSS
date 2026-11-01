import { api } from '../api/client.js';
import { publisherRankingsFingerprint, renderPublisherRankings } from '../components/publisher-rankings.js';
import { closeViewer, isViewerOpen, openArticle, openExternal, renderViewer } from '../services/article-viewer.js';
import { store } from '../state/store.js';
import { dom } from '../ui/dom.js';
import { isAbortError } from '../utils/data.js';
import { setSelectValue } from '../ui/select-dropdown.js';

let initialized = false;
let refreshPromise = null;
let pollTimer = null;
const pendingDismissals = new Set();

function selectedMedium() {
    return [...dom.rankings.medium.options].some(option => option.value === store.ui.rankingsMedium) ? store.ui.rankingsMedium : 'golem';
}

function publisherName() {
    const medium = selectedMedium();
    return store.rankings.payload?.media?.find(item => item.id === medium)?.name
        || [...dom.rankings.medium.options].find(option => option.value === medium)?.textContent || medium;
}

function clearPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
}

function schedulePoll(status = store.rankings.payload?.rankingStatus) {
    clearPoll();
    if (store.ui.activeView !== 'rankings' || refreshPromise || status?.state !== 'refreshing') return;
    pollTimer = setTimeout(() => {
        pollTimer = null;
        void loadRankings({ force: true, silent: true });
    }, 1500);
}

function updateControls(status = store.rankings.payload?.rankingStatus) {
    const refreshing = Boolean(refreshPromise) || status?.state === 'refreshing';
    dom.rankings.medium.disabled = refreshing;
    setSelectValue(dom.rankings.medium, selectedMedium());
    dom.rankings.refresh.disabled = refreshing || store.rankings.payload?.configured === false;
    dom.rankings.refresh.setAttribute('aria-busy', String(refreshing));
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-arrows-rotate';
    icon.setAttribute('aria-hidden', 'true');
    const label = refreshing ? 'Refreshing…' : status?.state === 'error' ? 'Retry refresh' : 'Refresh';
    dom.rankings.refresh.replaceChildren(icon, document.createTextNode(` ${label}`));
    const errorMessage = status?.errorCode === 'GOLEM_CONSENT_REQUIRED' ? 'Automatic Golem consent could not be completed.' : 'Refresh failed.';
    dom.rankings.refresh.title = status?.state === 'error' ? `${errorMessage} Retry refresh.` : `Refresh ${publisherName()} rankings`;
    dom.rankings.refresh.setAttribute('aria-label', status?.state === 'error' ? `${label}: ${errorMessage}` : label);
}

function render(payload, { status = payload?.rankingStatus } = {}) {
    const rankings = pendingDismissals.size ? payload?.rankings?.map(group => ({
        ...group, items: group.items.filter(item => !pendingDismissals.has(Number(item.articleId))),
    })) : payload?.rankings;
    const fingerprint = `${selectedMedium()}|${publisherRankingsFingerprint(rankings, status, payload?.configured)}`;
    if (fingerprint !== store.rankings.fingerprint) {
        store.rankings.fingerprint = fingerprint;
        store.rankings.articlesById = new Map();
        renderPublisherRankings(dom.rankings.content, rankings, store.rankings.articlesById, { status, configured: payload?.configured, publisherName: publisherName() });
        renderViewer();
    }
    updateControls(status);
}

function applyPayload(payload, medium = selectedMedium()) {
    if (payload?.medium !== medium || !Array.isArray(payload.rankings)) throw new Error('Invalid publisher rankings response');
    store.rankings.payload = payload;
    store.rankings.needsRefresh = false;
    render(payload);
}

export async function loadRankings({ force = false, silent = false } = {}) {
    const medium = selectedMedium();
    if (refreshPromise) { store.rankings.needsRefresh = true; return; }
    if (!force && !store.rankings.needsRefresh && store.rankings.payload?.medium === medium) return;
    clearPoll();
    store.rankings.requestController?.abort();
    const controller = new AbortController();
    const requestId = ++store.rankings.requestId;
    store.rankings.requestController = controller;
    if (!silent && !store.rankings.payload) render(null, { status: { state: 'loading' } });
    try {
        const payload = await api.rankings(medium, controller.signal);
        if (requestId !== store.rankings.requestId || medium !== selectedMedium()) return;
        applyPayload(payload, medium);
        schedulePoll(payload.rankingStatus);
    } catch (error) {
        if (isAbortError(error) || requestId !== store.rankings.requestId || medium !== selectedMedium()) return;
        store.rankings.needsRefresh = true;
        render(store.rankings.payload, { status: { state: 'error' } });
    } finally {
        if (store.rankings.requestController === controller) store.rankings.requestController = null;
    }
}

export function refreshRankings() {
    if (refreshPromise) return refreshPromise;
    if (store.rankings.payload?.configured === false) return Promise.resolve();
    const medium = selectedMedium();
    clearPoll();
    store.rankings.requestController?.abort();
    ++store.rankings.requestId;
    render(store.rankings.payload, { status: { state: 'refreshing' } });
    // Leaving this view stops status reads while the requested refresh finishes
    // on the server.
    refreshPromise = (async () => {
        let finalStatus;
        try {
            const payload = await api.refreshRankings(medium);
            if (medium !== selectedMedium()) return;
            applyPayload(payload, medium);
            finalStatus = payload.rankingStatus;
        } catch (error) {
            if (medium !== selectedMedium()) return;
            const status = error.status === 409 ? 'refreshing' : 'error';
            finalStatus = { ...error.data?.rankingStatus, state: status };
            if (error.data?.medium === medium && Array.isArray(error.data.rankings)) {
                applyPayload({ ...error.data, rankingStatus: finalStatus });
            } else {
                render(store.rankings.payload, { status: finalStatus });
                if (status === 'refreshing') store.rankings.needsRefresh = true;
            }
        } finally {
            refreshPromise = null;
            if (medium !== selectedMedium()) {
                store.rankings.needsRefresh = true;
                if (store.ui.activeView === 'rankings') void loadRankings({ force: true });
                return;
            }
            // A 409 may omit a payload; keep checking the running refresh rather
            // than turning its button into a second refresh request.
            updateControls(finalStatus);
            schedulePoll(finalStatus);
        }
    })();
    updateControls({ state: 'refreshing' });
    return refreshPromise;
}

async function dismissArticle(id) {
    const articleId = Number(id);
    if (!store.rankings.articlesById.has(articleId) || pendingDismissals.has(articleId)) return;
    pendingDismissals.add(articleId);
    store.rankings.requestController?.abort();
    ++store.rankings.requestId;
    render(store.rankings.payload);
    try {
        await api.dismissArticle(articleId, true);
        store.feed.needsRefresh = true;
        const { toast } = await import('../ui/toast.js');
        toast.success('Article dismissed', { actionLabel: 'Undo', onAction: async () => {
            await api.dismissArticle(articleId, false);
            store.feed.needsRefresh = true;
            await loadRankings({ force: true, silent: true });
            if (store.ui.activeView === 'main') {
                const { loadArticles } = await import('./feed.js');
                await loadArticles({ force: true, showLoading: false });
            }
        } });
    } catch (error) {
        const { toast } = await import('../ui/toast.js');
        toast.error(`Dismiss failed: ${error.message}`);
    } finally {
        pendingDismissals.delete(articleId);
        await loadRankings({ force: true, silent: true });
    }
}

async function activateCardAction(event) {
    const action = event.target.closest('[data-action]');
    const card = event.target.closest('.publisher-ranking-card');
    if (!action || !card || action.disabled) return;
    event.preventDefault(); event.stopPropagation();
    const id = Number(card.dataset.articleId) || null;
    if (action.dataset.action === 'read') {
        if (id) openArticle(id); else openExternal(null, card.dataset.itemUrl);
    } else if (action.dataset.action === 'external') openExternal(id, card.dataset.itemUrl);
    else if (action.dataset.action === 'save' && id) {
        const { openListModal } = await import('../ui/modal.js');
        await openListModal(id);
    } else if (action.dataset.action === 'dismiss' && id) await dismissArticle(id);
    else if (action.dataset.action === 'filter-source') {
        const { applySourceFilter } = await import('./feed.js');
        await applySourceFilter(action.dataset);
    } else if (action.dataset.action === 'filter-topic') {
        const { applyTopicFilter } = await import('./feed.js');
        await applyTopicFilter(action.dataset.topicSlug, { switchView: true });
    }
}

function bindEvents() {
    dom.rankings.medium.addEventListener('change', () => {
        const medium = dom.rankings.medium.value;
        if (refreshPromise || ![...dom.rankings.medium.options].some(option => option.value === medium)) {
            setSelectValue(dom.rankings.medium, selectedMedium());
            return;
        }
        if (medium === selectedMedium()) return;
        store.ui.rankingsMedium = medium;
        store.rankings.payload = null;
        store.rankings.needsRefresh = true;
        closeViewer();
        void loadRankings({ force: true });
    });
    dom.rankings.refresh.addEventListener('click', () => { void refreshRankings(); });
    dom.rankings.content.addEventListener('click', event => {
        void activateCardAction(event).catch(async error => {
            const { toast } = await import('../ui/toast.js');
            toast.error(error.message);
        });
    });
    dom.rankings.content.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.target.closest('button, a')) return;
        const card = event.target.closest('.publisher-ranking-card');
        if (!card) return;
        event.preventDefault();
        if (card.dataset.articleId) openArticle(card.dataset.articleId);
        else openExternal(null, card.dataset.itemUrl);
    });
    window.addEventListener('keydown', event => {
        if (event.defaultPrevented || store.ui.activeView !== 'rankings' || document.querySelector('dialog[open], [data-oj-dropdown-trigger][aria-expanded="true"]')) return;
        if (event.key === 'Escape' && isViewerOpen()) { event.preventDefault(); closeViewer(); }
    });
}

export async function activateRankings() {
    if (!initialized) {
        initialized = true;
        store.rankings.initialized = true;
        bindEvents();
    }
    await loadRankings({ force: true, silent: Boolean(store.rankings.payload) });
}

export function deactivateRankings() {
    clearPoll();
    store.rankings.requestController?.abort();
}

export function markRankingsDirty() { store.rankings.needsRefresh = true; }
