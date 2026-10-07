import { api } from './js/api/client.js';
import { initArticleViewer } from './js/services/article-viewer.js';
import { closeEvents, initEvents } from './js/services/events.js';
import { initLayout } from './js/services/layout.js';
import { setFeeds, setLists, setTopics, store } from './js/state/store.js';
import { initModal } from './js/ui/modal.js';
import { initNavigation } from './js/ui/navigation.js';
import { initOJ } from './js/ui/design-system.js';
import { toast } from './js/ui/toast.js';
import {
    activateFeed,
    deactivateFeed,
    initFeed,
    loadArticles,
    markFeedDirty,
    refreshFeedReferences,
    searchFromSelection,
} from './js/views/feed.js';
import { initFeedImport } from './js/views/feed-import.js';

const controllers = new Map([
    ['main', { activate: activateFeed, deactivate: deactivateFeed }],
]);
let activeController = 'main';
let settingsModule = null;
let activationId = 0;
let cleanupDesignSystem = () => {};

async function loadReferences() {
    const results = await Promise.allSettled([api.feeds(), api.lists(), api.topics()]);
    setFeeds(results[0].status === 'fulfilled' ? results[0].value : []);
    setLists(results[1].status === 'fulfilled' ? results[1].value : []);
    setTopics(results[2].status === 'fulfilled' ? results[2].value?.topics : []);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) toast.error(`Could not load ${failures.length} reference data source${failures.length === 1 ? '' : 's'}.`);
}

async function refreshReferences(kind) {
    if (kind === 'feeds') setFeeds(await api.feeds());
    if (kind === 'lists') setLists(await api.lists());
    if (kind === 'topics') setTopics((await api.topics())?.topics);
    refreshFeedReferences();
    settingsModule?.refreshSettingsReferences();
}

async function ensureController(name) {
    if (controllers.has(name)) return controllers.get(name);
    if (name === 'digest') {
        const module = await import('./js/views/digest.js');
        const controller = {
            activate: module.activateDigest,
            deactivate: module.deactivateDigest,
            dirty: module.markDigestDirty,
        };
        controllers.set(name, controller);
        return controller;
    }
    if (name === 'settings') {
        settingsModule = await import('./js/views/settings.js');
        const options = {
            onReferencesChanged: async () => refreshFeedReferences(),
            onFeedChanged: async () => {
                markFeedDirty();
                if (store.ui.activeView === 'main') await loadArticles({ force: true, showLoading: false });
            },
            onDigestChanged: () => controllers.get('digest')?.dirty?.(),
        };
        const controller = {
            activate: () => settingsModule.activateSettings(options),
            deactivate: settingsModule.deactivateSettings,
        };
        controllers.set(name, controller);
        return controller;
    }
    return controllers.get('main');
}

async function activate(name) {
    const requestId = ++activationId;
    if (activeController !== name) controllers.get(activeController)?.deactivate?.();
    const controller = await ensureController(name);
    if (requestId !== activationId || store.ui.activeView !== name) {
        controller?.deactivate?.();
        return;
    }
    activeController = name;
    await controller.activate?.();
}

function markDigestDirty() {
    store.digest.needsRefresh = true;
    controllers.get('digest')?.dirty?.();
}

function setupLiveUpdates() {
    initEvents({
        fetchCompleted: () => {
            markFeedDirty();
            markDigestDirty();
            if (store.ui.activeView === 'main') void loadArticles({ force: true, showLoading: false });
            void settingsModule?.refreshSettingsMeta();
        },
        feedsUpdated: () => {
            void refreshReferences('feeds');
            markFeedDirty();
            markDigestDirty();
            if (store.ui.activeView === 'main') void loadArticles({ force: true, showLoading: false });
        },
        listsUpdated: () => void refreshReferences('lists'),
        listItemsUpdated: () => {
            markFeedDirty();
            if (store.ui.activeView === 'main') void loadArticles({ force: true, showLoading: false });
        },
        topicsUpdated: () => {
            void refreshReferences('topics');
            void settingsModule?.reloadTopicRules();
        },
        digestSettingsUpdated: () => {
            markDigestDirty();
            void settingsModule?.reloadDigestSettings();
        },
        bullshitRulesUpdated: () => {
            markFeedDirty();
            void settingsModule?.reloadBullshitRules();
        },
        articlesUpdated: () => {
            if (store.digest.pendingMutationEvents > 0) {
                store.digest.pendingMutationEvents -= 1;
                return;
            }
            markDigestDirty();
        },
    });
}

async function init() {
    cleanupDesignSystem = initOJ();
    initLayout();
    initArticleViewer();
    initNavigation(activate);
    initModal({
        onSaved: async () => {
            markFeedDirty();
            if (store.ui.activeView === 'main') await loadArticles({ force: true, showLoading: false });
        },
    });
    initFeedImport({
        onImported: async () => {
            await refreshReferences('feeds');
            markFeedDirty();
            markDigestDirty();
            if (store.ui.activeView === 'main') await loadArticles({ force: true, showLoading: false });
        },
    });
    await loadReferences();
    await initFeed();
    setupLiveUpdates();
    window.__nbsSearchSelection = searchFromSelection;
}

function cleanup() {
    cleanupDesignSystem();
    closeEvents();
    controllers.forEach(controller => controller.deactivate?.());
}

window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

init().catch(error => {
    console.error('Frontend initialization failed:', error);
    const state = document.getElementById('articles-state');
    if (state) state.textContent = `Error: ${error.message}`;
});
