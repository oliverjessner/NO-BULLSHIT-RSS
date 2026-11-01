import { api } from '../api/client.js';
import { publisherRankingsFingerprint, renderPublisherRankings } from '../components/publisher-rankings.js';
import { closeViewer, isViewerOpen, openArticle, openExternal, renderViewer } from '../services/article-viewer.js';
import { store } from '../state/store.js';
import { dom } from '../ui/dom.js';
import { isAbortError } from '../utils/data.js';

let initialized = false;
let refreshPromise = null;
let pollTimer = null;

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
    dom.rankings.medium.value = 'golem';
    dom.rankings.medium.disabled = refreshing;
    dom.rankings.refresh.disabled = refreshing || store.rankings.payload?.configured === false;
    dom.rankings.refresh.setAttribute('aria-busy', String(refreshing));
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-arrows-rotate';
    icon.setAttribute('aria-hidden', 'true');
    const label = refreshing ? 'Refreshing…' : status?.state === 'error' ? 'Retry refresh' : 'Refresh';
    dom.rankings.refresh.replaceChildren(icon, document.createTextNode(` ${label}`));
}

function render(payload, { status = payload?.rankingStatus } = {}) {
    const fingerprint = publisherRankingsFingerprint(payload?.rankings, status, payload?.configured);
    if (fingerprint !== store.rankings.fingerprint) {
        store.rankings.fingerprint = fingerprint;
        store.rankings.articlesById = new Map();
        renderPublisherRankings(dom.rankings.content, payload?.rankings, store.rankings.articlesById, { status, configured: payload?.configured });
        renderViewer();
    }
    updateControls(status);
}

function applyPayload(payload) {
    if (payload?.medium !== 'golem' || !Array.isArray(payload.rankings)) throw new Error('Invalid publisher rankings response');
    store.rankings.payload = payload;
    store.rankings.needsRefresh = false;
    render(payload);
}

export async function loadRankings({ force = false, silent = false } = {}) {
    if (refreshPromise) { store.rankings.needsRefresh = true; return; }
    if (!force && !store.rankings.needsRefresh && store.rankings.payload) return;
    clearPoll();
    store.rankings.requestController?.abort();
    const controller = new AbortController();
    const requestId = ++store.rankings.requestId;
    store.rankings.requestController = controller;
    if (!silent && !store.rankings.payload) render(null, { status: { state: 'loading' } });
    try {
        const payload = await api.rankings('golem', controller.signal);
        if (requestId !== store.rankings.requestId) return;
        applyPayload(payload);
        schedulePoll(payload.rankingStatus);
    } catch (error) {
        if (isAbortError(error) || requestId !== store.rankings.requestId) return;
        store.rankings.needsRefresh = true;
        render(store.rankings.payload, { status: { state: 'error' } });
    } finally {
        if (store.rankings.requestController === controller) store.rankings.requestController = null;
    }
}

export function refreshRankings() {
    if (refreshPromise) return refreshPromise;
    if (store.rankings.payload?.configured === false) return Promise.resolve();
    clearPoll();
    store.rankings.requestController?.abort();
    ++store.rankings.requestId;
    render(store.rankings.payload, { status: { state: 'refreshing' } });
    // The selected medium alone is refreshed. Leaving this view stops status
    // reads but lets the explicitly requested refresh finish on the server.
    refreshPromise = (async () => {
        let finalStatus;
        try {
            const payload = await api.refreshRankings('golem');
            applyPayload(payload);
            finalStatus = payload.rankingStatus;
        } catch (error) {
            const status = error.status === 409 ? 'refreshing' : 'error';
            finalStatus = { ...error.data?.rankingStatus, state: status };
            if (error.data?.medium === 'golem' && Array.isArray(error.data.rankings)) {
                applyPayload({ ...error.data, rankingStatus: finalStatus });
            } else {
                render(store.rankings.payload, { status: finalStatus });
                if (status === 'refreshing') store.rankings.needsRefresh = true;
            }
        } finally {
            refreshPromise = null;
            // A 409 may omit a payload; keep checking the running refresh rather
            // than turning its button into a second refresh request.
            updateControls(finalStatus);
            schedulePoll(finalStatus);
        }
    })();
    updateControls({ state: 'refreshing' });
    return refreshPromise;
}

function bindEvents() {
    dom.rankings.medium.addEventListener('change', () => {
        // Golem is the only supported medium until another adapter is added.
        dom.rankings.medium.value = 'golem';
        store.ui.rankingsMedium = 'golem';
        void loadRankings({ force: true, silent: true });
    });
    dom.rankings.refresh.addEventListener('click', () => { void refreshRankings(); });
    dom.rankings.content.addEventListener('click', event => {
        const link = event.target.closest('.publisher-ranking-link');
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (link.dataset.articleId) openArticle(link.dataset.articleId);
        else openExternal(null, link.dataset.itemUrl);
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
