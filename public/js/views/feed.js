import { api } from '../api/client.js';
import { createArticleCard } from '../components/article-card.js';
import { CONFIG } from '../config.js';
import { closeViewer, isViewerOpen, openArticle, openExternal, renderViewer } from '../services/article-viewer.js';
import { store } from '../state/store.js';
import { dom } from '../ui/dom.js';
import { openListModal } from '../ui/modal.js';
import { navigate } from '../ui/navigation.js';
import { toast } from '../ui/toast.js';
import { bindExportMenu } from '../ui/export-menu.js';
import { debounce, fingerprintArticles, isAbortError, normalizeSearch } from '../utils/data.js';
import { clear, hide, option, show, text } from '../utils/dom.js';
import { createFeedExport, downloadExport, fetchAllFeedArticles } from '../utils/export.js';

let initialized = false;
let observer = null;

function requestKey() {
    return new URLSearchParams({
        feedId: dom.feed.sourceFilter.value,
        listId: dom.feed.listFilter.value,
        topic: dom.feed.topicFilter.value,
        query: normalizeSearch(dom.feed.search.value, CONFIG.MAX_SEARCH_QUERY_LENGTH),
        bullshit: dom.feed.bullshitFilter.value,
    }).toString();
}

function exportSnapshot() {
    const params = new URLSearchParams(requestKey());
    for (const [name, value] of [...params]) if (!value) params.delete(name);
    const topic = dom.feed.topicFilter.value ? filterLabel(dom.feed.topicFilter, 'Topic') : null;
    const source = dom.feed.sourceFilter.value ? filterLabel(dom.feed.sourceFilter, 'Source') : null;
    const list = dom.feed.listFilter.value ? filterLabel(dom.feed.listFilter, 'List') : null;
    return {
        params,
        filters: {
            query: params.get('query'),
            topic,
            source,
            listId: params.get('listId'),
            bullshit: params.get('bullshit') === 'all' ? null : params.get('bullshit'),
        },
        filterLabels: { topic, source, list },
    };
}

async function exportFeed(format) {
    const snapshot = exportSnapshot();
    try {
        const articles = await fetchAllFeedArticles(params => api.articles(params.toString()), snapshot.params);
        const artifact = createFeedExport(format, { articles, filters: snapshot.filters, filterLabels: snapshot.filterLabels });
        downloadExport(artifact);
        toast.success(`Exported ${articles.length.toLocaleString('en-US')} ${articles.length === 1 ? 'article' : 'articles'}.`);
    } catch (error) {
        toast.error(`Export failed: ${error.message}`);
    }
}

function renderFilterSelect(select, defaultLabel, values, label, value) {
    const selected = select.value;
    clear(select); option(select, '', defaultLabel);
    for (const item of values) option(select, value(item), label(item));
    select.value = [...select.options].some(item => item.value === selected) ? selected : '';
}

export function refreshFeedReferences() {
    renderFilterSelect(dom.feed.sourceFilter, 'Source: All', store.reference.feeds, feed => `Source: ${feed.name}`, feed => String(feed.id));
    renderFilterSelect(dom.feed.listFilter, 'List: All', store.reference.lists, list => `List: ${list.name}`, list => String(list.id));
    renderFilterSelect(dom.feed.topicFilter, 'Topic: All', store.reference.topics, topic => `Topic: ${topic.label || topic.slug}`, topic => topic.slug);
    renderFilterChips();
}

function filterLabel(select, prefix) {
    return String(select.selectedOptions?.[0]?.textContent || '').replace(new RegExp(`^${prefix}:\\s*`, 'i'), '');
}

function activeFilters() {
    const filters = [];
    const query = normalizeSearch(dom.feed.search.value, CONFIG.MAX_SEARCH_QUERY_LENGTH);
    if (query) filters.push(['query', `“${query}”`]);
    if (dom.feed.topicFilter.value) filters.push(['topic', filterLabel(dom.feed.topicFilter, 'Topic')]);
    if (dom.feed.sourceFilter.value) filters.push(['source', filterLabel(dom.feed.sourceFilter, 'Source')]);
    if (dom.feed.listFilter.value) filters.push(['list', filterLabel(dom.feed.listFilter, 'List')]);
    if (dom.feed.bullshitFilter.value !== 'all') filters.push(['bullshit', filterLabel(dom.feed.bullshitFilter, 'Bullshit')]);
    return filters;
}

function renderFilterChips() {
    const filters = activeFilters();
    const fragment = document.createDocumentFragment();
    for (const [key, label] of filters) {
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'active-filter-chip pf-badge pf-badge-muted';
        chip.dataset.filterKey = key; chip.textContent = `${label} ×`; chip.setAttribute('aria-label', `Remove ${label} filter`); fragment.appendChild(chip);
    }
    dom.feed.filterChips.replaceChildren(fragment);
    dom.feed.filterRow.classList.toggle('hide', filters.length === 0);
}

function renderPagination() {
    dom.feed.loadMore.classList.toggle('hide', !store.feed.hasMore);
    dom.feed.loadMore.disabled = store.feed.loadingMore;
    text(dom.feed.loadMore, store.feed.loadingMore ? 'Loading more…' : 'Load more');
}

function renderArticles(articles, { append = false, key = '' } = {}) {
    const fingerprint = fingerprintArticles(append ? store.feed.articles : articles);
    if (!append && key === store.feed.requestKey && fingerprint === store.feed.fingerprint) { renderViewer(); return; }
    const fragment = document.createDocumentFragment();
    const items = articles;
    if (!append) store.feed.articlesById = new Map();
    for (const article of items) {
        const id = Number(article?.id); if (Number.isInteger(id) && id > 0) store.feed.articlesById.set(id, article);
        fragment.appendChild(createArticleCard(article, dom.feed.template, dom.feed.topicFilter.value));
    }
    if (append) dom.feed.list.appendChild(fragment); else dom.feed.list.replaceChildren(fragment);
    store.feed.requestKey = key; store.feed.fingerprint = fingerprint;
    if (!articles.length) { text(dom.feed.state, dom.feed.bullshitFilter.value === 'bullshit' ? 'No bullshit found.' : 'Nothing found, try other search input or delete all'); show(dom.feed.state); }
    else hide(dom.feed.state);
    renderViewer();
}

export async function loadFeedCount() {
    try { const stats = await api.articleStats(); text(dom.feed.count, `${Number(stats?.unread || 0).toLocaleString('en-US')} unread`); }
    catch { text(dom.feed.count, 'Unread count unavailable'); }
}

export async function loadArticles({ append = false, showLoading = true, force = false } = {}) {
    if (append && (!store.feed.hasMore || store.feed.loadingMore)) return;
    const key = requestKey();
    if (!append && !force && !store.feed.needsRefresh && key === store.feed.requestKey) return;
    store.feed.requestController?.abort();
    const controller = new AbortController();
    const requestId = ++store.feed.requestId;
    store.feed.requestController = controller; store.feed.loadingMore = append;
    if (!append) store.feed.hasMore = false;
    renderPagination(); renderFilterChips(); hide(dom.feed.state);
    if (showLoading) show(dom.feed.loading);
    const params = new URLSearchParams(key);
    for (const [name, value] of [...params]) if (!value) params.delete(name);
    params.set('limit', String(CONFIG.ARTICLES_PAGE_SIZE + 1));
    if (append) {
        const cursor = store.feed.articles.at(-1);
        if (cursor?.publishedAt && cursor?.id) {
            params.set('cursorPublishedAt', cursor.publishedAt);
            params.set('cursorId', String(cursor.id));
        }
    }
    try {
        const payload = await api.articles(params.toString(), controller.signal);
        if (requestId !== store.feed.requestId) return;
        const page = Array.isArray(payload) ? payload : [];
        const visible = page.slice(0, CONFIG.ARTICLES_PAGE_SIZE);
        if (append) {
            const known = new Set(store.feed.articles.map(article => Number(article.id)));
            const additions = visible.filter(article => !known.has(Number(article.id)));
            store.feed.articles.push(...additions);
            renderArticles(additions, { append: true, key });
        } else {
            store.feed.articles = visible;
            renderArticles(visible, { key });
        }
        store.feed.hasMore = page.length > CONFIG.ARTICLES_PAGE_SIZE;
        store.feed.needsRefresh = false;
        await loadFeedCount();
    } catch (error) {
        if (isAbortError(error) || requestId !== store.feed.requestId) return;
        if (append) toast.error(`Could not load more articles: ${error.message}`);
        else { text(dom.feed.state, `Error: ${error.message}`); show(dom.feed.state); store.feed.needsRefresh = true; }
    } finally {
        if (store.feed.requestController === controller) store.feed.requestController = null;
        store.feed.loadingMore = false; hide(dom.feed.loading); renderPagination();
    }
}

function cards() { return [...dom.feed.list.querySelectorAll('.feed-card[data-article-id]')]; }
function focusArticle(id, focus = false) {
    const target = cards().find(card => Number(card.dataset.articleId) === Number(id));
    if (!target) return;
    store.feed.focusedArticleId = Number(id);
    cards().forEach(card => card.classList.toggle('is-keyboard-active', card === target));
    if (focus) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

async function dismiss(id) {
    const normalized = Number(id);
    const card = cards().find(item => Number(item.dataset.articleId) === normalized);
    const article = store.feed.articlesById.get(normalized);
    if (!card || !article) return;
    card.remove(); store.feed.articlesById.delete(normalized); store.feed.articles = store.feed.articles.filter(item => Number(item.id) !== normalized);
    try {
        await api.dismissArticle(normalized, true); await loadFeedCount();
        toast.success('Article dismissed', { actionLabel: 'Undo', onAction: async () => { await api.dismissArticle(normalized, false); store.feed.needsRefresh = true; await loadArticles({ showLoading: false, force: true }); } });
    } catch (error) { store.feed.needsRefresh = true; await loadArticles({ showLoading: false, force: true }); toast.error(`Dismiss failed: ${error.message}`); }
}

export async function applyTopicFilter(slug, { switchView = false } = {}) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (![...dom.feed.topicFilter.options].some(item => item.value === normalized)) return;
    dom.feed.topicFilter.value = normalized;
    if (switchView) await navigate('main');
    await loadArticles({ force: true });
}

export async function applySourceFilter({ feedId, sourceName } = {}) {
    let id = String(feedId || '');
    if (!id) id = String(store.reference.feeds.find(feed => String(feed.name).toLowerCase() === String(sourceName).toLowerCase())?.id || '');
    if (!id) return;
    dom.feed.sourceFilter.value = id;
    await navigate('main');
    await loadArticles({ force: true });
}

async function clearFilter(key) {
    if (key === 'query') dom.feed.search.value = '';
    if (key === 'topic') dom.feed.topicFilter.value = '';
    if (key === 'source') dom.feed.sourceFilter.value = '';
    if (key === 'list') dom.feed.listFilter.value = '';
    if (key === 'bullshit') dom.feed.bullshitFilter.value = 'all';
    renderFilterChips(); await loadArticles({ force: true });
}

async function clearFilters() {
    dom.feed.search.value = ''; dom.feed.topicFilter.value = ''; dom.feed.sourceFilter.value = ''; dom.feed.listFilter.value = ''; dom.feed.bullshitFilter.value = 'all';
    renderFilterChips(); await loadArticles({ force: true });
}

function bindEvents() {
    bindExportMenu({
        root: dom.feed.exportMenu,
        trigger: dom.feed.exportTrigger,
        popover: dom.feed.exportPopover,
        onSelect: exportFeed,
    });
    const search = debounce(() => void loadArticles({ showLoading: false, force: true }), CONFIG.SEARCH_DEBOUNCE_MS);
    dom.feed.search.addEventListener('input', () => { renderFilterChips(); search(); });
    [dom.feed.topicFilter, dom.feed.sourceFilter, dom.feed.listFilter, dom.feed.bullshitFilter].forEach(select => select.addEventListener('change', () => void loadArticles({ force: true })));
    dom.feed.clearFilters.addEventListener('click', () => void clearFilters());
    dom.feed.filterChips.addEventListener('click', event => { const chip = event.target.closest('[data-filter-key]'); if (chip) void clearFilter(chip.dataset.filterKey); });
    dom.feed.loadMore.addEventListener('click', () => void loadArticles({ append: true, showLoading: false }));
    dom.feed.backToTop.addEventListener('click', () => { const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; dom.feed.scroll?.scrollTo({ top: 0, behavior }); window.scrollTo({ top: 0, behavior }); });
    dom.feed.list.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]');
        const card = event.target.closest('.feed-card[data-article-id]');
        if (!card) return;
        const id = Number(card.dataset.articleId); focusArticle(id);
        if (!action) return;
        event.preventDefault(); event.stopPropagation();
        if (action.dataset.action === 'read') openArticle(id);
        else if (action.dataset.action === 'external') openExternal(id);
        else if (action.dataset.action === 'save') await openListModal(id);
        else if (action.dataset.action === 'dismiss') await dismiss(id);
        else if (action.dataset.action === 'filter-topic') await applyTopicFilter(action.dataset.topicSlug);
        else if (action.dataset.action === 'filter-source') await applySourceFilter(action.dataset);
    });
    dom.feed.list.addEventListener('focusin', event => { const card = event.target.closest('.feed-card[data-article-id]'); if (card) focusArticle(card.dataset.articleId); });
    window.addEventListener('keydown', event => {
        const target = event.target;
        if (event.defaultPrevented || store.ui.activeView !== 'main' || target?.matches?.('input,select,textarea') || target?.isContentEditable || event.metaKey || event.ctrlKey || event.altKey || dom.modal.backdrop.classList.contains('is-open')) return;
        const key = String(event.key).toLowerCase();
        if (key === 'j' || key === 'k') {
            event.preventDefault(); const list = cards(); if (!list.length) return;
            const current = list.findIndex(card => Number(card.dataset.articleId) === store.feed.focusedArticleId);
            const index = current < 0 ? (key === 'j' ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, current + (key === 'j' ? 1 : -1)));
            focusArticle(list[index].dataset.articleId, true); return;
        }
        const id = store.feed.focusedArticleId || Number(cards()[0]?.dataset.articleId);
        if (key === 's' && id) { event.preventDefault(); void openListModal(id); return; }
        if (key === 'd' && id) { event.preventDefault(); void dismiss(id); return; }
        if (event.key === 'Enter' && id) { event.preventDefault(); openArticle(id); return; }
        if (event.key === 'Escape' && isViewerOpen()) { event.preventDefault(); closeViewer(); return; }
        if (event.key === 'Escape' && activeFilters().length) { event.preventDefault(); void clearFilters(); }
    });
    if ('IntersectionObserver' in window) {
        observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && store.ui.activeView === 'main') void loadArticles({ append: true, showLoading: false }); }, { rootMargin: '320px 0px' });
        observer.observe(dom.feed.loadMore);
    }
}

export async function initFeed() {
    if (initialized) return;
    initialized = true; store.feed.initialized = true; bindEvents(); refreshFeedReferences();
    await loadArticles({ force: true });
}

export async function activateFeed() { if (store.feed.needsRefresh) await loadArticles({ showLoading: false, force: true }); }
export function deactivateFeed() { store.feed.requestController?.abort(); }
export function markFeedDirty() { store.feed.needsRefresh = true; }
export function searchFromSelection(value) { dom.feed.search.value = normalizeSearch(value, CONFIG.MAX_SEARCH_QUERY_LENGTH); return navigate('main').then(() => loadArticles({ force: true })); }
