import { dom } from '../ui/dom.js';
import { store } from '../state/store.js';
import { STORAGE_KEYS } from '../config.js';
import { hide, setPressed, show, text } from '../utils/dom.js';
import { normalizeArticleUrl } from '../utils/format.js';
import { createViewerSync, invokeDesktop, isDesktop, openBrowser } from './desktop.js';

const viewerState = { open: false, url: null, articleId: null, title: 'Article viewer', message: '' };
const viewerContexts = { main: dom.viewer.feed, digest: dom.viewer.digest, rankings: dom.viewer.rankings };
const syncNative = createViewerSync(payload => invokeDesktop('sync_article_viewer', payload));
let syncScheduled = false;

function scheduleNativeViewer() {
    if (!isDesktop || syncScheduled) return;
    syncScheduled = true;
    // WebKit can suspend rAF in the main view when a child webview overlaps it.
    // A microtask also updates modal visibility before the next browser paint.
    queueMicrotask(() => {
        syncScheduled = false;
        const context = viewerContexts[store.ui.activeView];
        if (!context) { void syncNative({ url: null, bounds: null }); return; }
        const rect = context.frame.getBoundingClientRect();
        const visible = viewerState.open && viewerState.url
            && !document.querySelector('dialog[open]') && !context.panel.classList.contains('hide');
        const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
        const width = Math.min(window.innerWidth, rect.right) - x;
        const height = Math.min(window.innerHeight, rect.bottom) - y;
        void syncNative(visible && width > 0 && height > 0
            ? { url: viewerState.url, bounds: { x, y, width, height } }
            : { url: null, bounds: null });
    });
}

function articleById(id) {
    const normalized = Number(id);
    const active = store.ui.activeView === 'main' ? store.feed : store[store.ui.activeView];
    return active?.articlesById?.get(normalized) || store.feed.articlesById.get(normalized)
        || store.digest.articlesById.get(normalized) || store.rankings.articlesById.get(normalized) || null;
}

function setActiveCards() {
    for (const card of document.querySelectorAll('[data-article-id].feed-card, [data-article-id].digest-item-card, [data-article-id].publisher-ranking-link')) {
        const inActiveView = card.closest(`#view-${store.ui.activeView}`);
        card.classList.toggle('is-active', viewerState.open && Boolean(inActiveView) && Number(card.dataset.articleId) === viewerState.articleId);
    }
}

export function renderViewer() {
    for (const [view, context] of Object.entries(viewerContexts)) {
        const visible = viewerState.open && store.ui.activeView === view;
        context.layout.dataset.viewerWidth = store.ui.viewerWidth;
        context.layout.classList.toggle('is-viewer-open', visible);
        text(context.title, viewerState.title);
        if (!visible) {
            hide(context.panel); hide(context.frame); hide(context.message);
            context.frame.removeAttribute('src'); context.frame.removeAttribute('data-loaded-url');
            continue;
        }
        show(context.panel);
        if (viewerState.url) {
            if (context.frame.dataset.loadedUrl !== viewerState.url) {
                if (!isDesktop) context.frame.src = viewerState.url;
                context.frame.dataset.loadedUrl = viewerState.url;
            }
            hide(context.message); show(context.frame);
        } else {
            context.frame.removeAttribute('src'); context.frame.removeAttribute('data-loaded-url');
            hide(context.frame); text(context.message, viewerState.message || 'No article selected.'); show(context.message);
        }
    }
    setPressed(dom.viewer.widthOptions, option => option.dataset.viewerWidth === store.ui.viewerWidth);
    setActiveCards();
    scheduleNativeViewer();
}

export function openArticle(id) {
    const article = articleById(id);
    if (!article) return;
    viewerState.open = true;
    viewerState.articleId = Number(article.id);
    viewerState.url = normalizeArticleUrl(article.url);
    viewerState.title = String(article.title || 'Untitled');
    viewerState.message = viewerState.url ? '' : 'This article has no valid URL for the in-app viewer.';
    renderViewer();
}

export function openExternal(id, fallbackUrl = '') {
    const article = articleById(id);
    const url = normalizeArticleUrl(article?.url || fallbackUrl);
    if (url) { void openBrowser(url).catch(console.error); return; }
    viewerState.open = true; viewerState.articleId = Number(article?.id) || null; viewerState.url = null;
    viewerState.title = article?.title || 'Untitled'; viewerState.message = 'This article has no valid URL to open externally.';
    renderViewer();
}

export function closeViewer() {
    Object.assign(viewerState, { open: false, url: null, articleId: null, title: 'Article viewer', message: '' });
    renderViewer();
}

export function isViewerOpen() { return viewerState.open; }

export function initArticleViewer() {
    if (isDesktop) {
        for (const context of Object.values(viewerContexts)) {
            context.frame.removeAttribute('src');
            context.frame.style.pointerEvents = 'none';
            context.frame.style.visibility = 'hidden';
        }
        new ResizeObserver(scheduleNativeViewer).observe(document.body);
        new MutationObserver(scheduleNativeViewer).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'class'] });
        window.addEventListener('resize', scheduleNativeViewer);
        document.addEventListener('scroll', scheduleNativeViewer, true);
    }
    Object.values(viewerContexts).forEach(context => context.hide?.addEventListener('click', closeViewer));
    dom.viewer.widthOptions.forEach(option => option.addEventListener('click', () => {
        const width = ['35', '50'].includes(option.dataset.viewerWidth) ? option.dataset.viewerWidth : '50';
        store.ui.viewerWidth = width;
        localStorage.setItem(STORAGE_KEYS.viewerWidth, width);
        renderViewer();
    }));
    renderViewer();
}
