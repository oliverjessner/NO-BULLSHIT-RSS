import { api } from '../api/client.js';
import { publisherRankingsFingerprint, renderPublisherRankings } from '../components/publisher-rankings.js';
import { closeViewer, isViewerOpen, openArticle, openExternal, renderViewer } from '../services/article-viewer.js';
import { store } from '../state/store.js';
import { dom } from '../ui/dom.js';
import { isAbortError } from '../utils/data.js';

let initialized = false;
let refreshPromise = null;
let accessPromise = null;
let pollTimer = null;
let visibleAccess = null;

const hasAccessJob = access => typeof access?.jobId === 'string' && access.jobId.length > 0;
const hasActiveAccess = access => hasAccessJob(access) || ['opening', 'awaiting_confirmation', 'saving', 'cancelling'].includes(access?.state);

function clearPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
}

function schedulePoll(status = store.rankings.payload?.rankingStatus, access = store.rankings.payload?.access) {
    clearPoll();
    const pendingAccess = hasActiveAccess(access);
    if (store.ui.activeView !== 'rankings' || refreshPromise || accessPromise || (status?.state !== 'refreshing' && !pendingAccess)) return;
    pollTimer = setTimeout(() => {
        pollTimer = null;
        void loadRankings({ force: true, silent: true });
    }, 1500);
}

function updateControls(status = store.rankings.payload?.rankingStatus, access = store.rankings.payload?.access) {
    const pendingAccess = hasActiveAccess(access);
    const refreshing = Boolean(refreshPromise) || status?.state === 'refreshing';
    const busy = refreshing || Boolean(accessPromise);
    dom.rankings.medium.value = 'golem';
    dom.rankings.medium.disabled = busy || pendingAccess;
    dom.rankings.refresh.disabled = busy || pendingAccess || store.rankings.payload?.configured === false;
    dom.rankings.refresh.setAttribute('aria-busy', String(refreshing));
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-arrows-rotate';
    icon.setAttribute('aria-hidden', 'true');
    const label = refreshing ? 'Refreshing…' : status?.state === 'error' ? 'Retry refresh' : 'Refresh';
    dom.rankings.refresh.replaceChildren(icon, document.createTextNode(` ${label}`));
    const job = hasAccessJob(access);
    dom.rankings.accessStart.disabled = busy || pendingAccess;
    dom.rankings.accessConfirm.hidden = access?.state !== 'awaiting_confirmation' || !job;
    dom.rankings.accessConfirm.disabled = busy;
    dom.rankings.accessCancel.hidden = !['opening', 'awaiting_confirmation'].includes(access?.state) || !job;
    dom.rankings.accessCancel.disabled = busy;
    dom.rankings.accessForget.hidden = !access?.saved && access?.state !== 'error';
    dom.rankings.accessForget.disabled = busy || pendingAccess;
}

function renderAccess(access, status) {
    const state = access?.state || 'idle';
    const message = state === 'opening' ? 'Opening Golem in a separate browser…'
        : state === 'awaiting_confirmation' ? 'Choose your consent or PUR option in the Golem window. Then return here and choose Save access.'
        : state === 'saving' ? 'Saving access and refreshing Golem rankings…'
        : state === 'cancelling' ? 'Closing Golem access setup…'
        : state === 'forgetting' ? 'Removing saved Golem access…'
        : state === 'error' && hasAccessJob(access) ? 'Golem setup is still active. Wait for it to finish before resetting access or opening another window.'
        : status?.errorCode === 'GOLEM_CONSENT_REQUIRED' ? 'Golem needs a consent or PUR choice. Set up access, complete your choice in the Golem window, then save it here.'
        : state === 'error' ? 'Golem access could not be completed. Use Forget saved access to reset it, or try Set up Golem access again.'
        : access?.saved ? 'Golem access is saved locally. Golem may ask you to choose again later.'
        : 'No Golem access saved.';
    dom.rankings.accessStatus.textContent = message;
}

function render(payload, { status = payload?.rankingStatus, access = payload?.access } = {}) {
    const fingerprint = publisherRankingsFingerprint(payload?.rankings, status, payload?.configured);
    if (fingerprint !== store.rankings.fingerprint) {
        store.rankings.fingerprint = fingerprint;
        store.rankings.articlesById = new Map();
        renderPublisherRankings(dom.rankings.content, payload?.rankings, store.rankings.articlesById, { status, configured: payload?.configured });
        renderViewer();
    }
    visibleAccess = access || null;
    renderAccess(access, status);
    updateControls(status, access);
}

function applyPayload(payload) {
    if (payload?.medium !== 'golem' || !Array.isArray(payload.rankings)) throw new Error('Invalid publisher rankings response');
    store.rankings.payload = payload;
    store.rankings.needsRefresh = false;
    render(payload);
}

export async function loadRankings({ force = false, silent = false } = {}) {
    if (refreshPromise || accessPromise) { store.rankings.needsRefresh = true; return; }
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
        const access = store.rankings.payload?.access;
        render(store.rankings.payload, { status: { state: 'error' }, access: hasActiveAccess(access) ? { ...access, state: 'error' } : access });
        if (hasActiveAccess(access)) schedulePoll({ state: 'error' }, access);
    } finally {
        if (store.rankings.requestController === controller) store.rankings.requestController = null;
    }
}

export function refreshRankings() {
    if (refreshPromise) return refreshPromise;
    if (accessPromise) return accessPromise;
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

function runAccessAction(action, pendingState) {
    if (accessPromise) return accessPromise;
    if (refreshPromise) return refreshPromise;
    clearPoll();
    store.rankings.requestController?.abort();
    ++store.rankings.requestId;
    const previousAccess = store.rankings.payload?.access || { state: 'idle', jobId: null, saved: false, savedAt: null, message: null };
    const pendingStatus = pendingState === 'saving'
        ? { ...store.rankings.payload?.rankingStatus, state: 'refreshing', errorCode: null }
        : store.rankings.payload?.rankingStatus;
    render(store.rankings.payload, { status: pendingStatus, access: { ...previousAccess, state: pendingState } });
    accessPromise = (async () => {
        let finalStatus = store.rankings.payload?.rankingStatus;
        let finalAccess;
        try {
            const payload = await action();
            applyPayload(payload);
            finalStatus = payload.rankingStatus;
            finalAccess = payload.access;
        } catch (error) {
            if (error.data?.medium === 'golem' && Array.isArray(error.data.rankings)) {
                applyPayload(error.data);
                finalStatus = error.data.rankingStatus;
                finalAccess = error.data.access;
            } else {
                finalAccess = { ...previousAccess, state: 'error' };
                render(store.rankings.payload, { access: finalAccess });
            }
        } finally {
            accessPromise = null;
            updateControls(finalStatus, finalAccess);
            schedulePoll(finalStatus, finalAccess);
        }
    })();
    updateControls(pendingStatus, { ...previousAccess, state: pendingState });
    return accessPromise;
}

export function startRankingsAccess() {
    if (hasActiveAccess(visibleAccess || store.rankings.payload?.access)) return Promise.resolve();
    return runAccessAction(() => api.startRankingsAccess('golem'), 'opening');
}

export function confirmRankingsAccess() {
    const access = store.rankings.payload?.access;
    if (access?.state !== 'awaiting_confirmation' || !access.jobId) return Promise.resolve();
    return runAccessAction(() => api.confirmRankingsAccess('golem', access.jobId), 'saving');
}

export function cancelRankingsAccess() {
    const access = store.rankings.payload?.access;
    if (!['opening', 'awaiting_confirmation'].includes(access?.state) || !access.jobId) return Promise.resolve();
    return runAccessAction(() => api.cancelRankingsAccess('golem', access.jobId), 'cancelling');
}

export function forgetRankingsAccess() {
    const access = visibleAccess || store.rankings.payload?.access;
    if (hasActiveAccess(access) || (!access?.saved && access?.state !== 'error')) return Promise.resolve();
    return runAccessAction(() => api.forgetRankingsAccess('golem'), 'forgetting');
}

function bindEvents() {
    dom.rankings.medium.addEventListener('change', () => {
        // Golem is the only supported medium until another adapter is added.
        dom.rankings.medium.value = 'golem';
        store.ui.rankingsMedium = 'golem';
        void loadRankings({ force: true, silent: true });
    });
    dom.rankings.refresh.addEventListener('click', () => { void refreshRankings(); });
    dom.rankings.accessStart.addEventListener('click', () => { void startRankingsAccess(); });
    dom.rankings.accessConfirm.addEventListener('click', () => { void confirmRankingsAccess(); });
    dom.rankings.accessCancel.addEventListener('click', () => { void cancelRankingsAccess(); });
    dom.rankings.accessForget.addEventListener('click', () => { void forgetRankingsAccess(); });
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
