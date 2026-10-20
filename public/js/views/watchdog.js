import { api } from '../api/client.js';
import { store } from '../state/store.js';
import { navigate } from '../ui/navigation.js';
import { openDialog, closeDialog, confirmDialog } from '../ui/design-system.js';
import { syncSelectDropdown } from '../ui/select-dropdown.js';
import { toast } from '../ui/toast.js';
import { isDesktop, invokeDesktop, openBrowser } from '../services/desktop.js';
import { normalizeArticleUrl } from '../utils/format.js';
import { parseWatchdogTerms } from '../utils/watchdog.js';
import { bindExportMenu } from '../ui/export-menu.js';
import { createFeedExport, downloadExport, fetchAllFeedArticles } from '../utils/export.js';
import { openListModal } from '../ui/modal.js';

const byId = id => document.getElementById(id);
const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};
const state = { rules: [], matches: [], request: 0, hasMore: false, loading: false, editing: null, active: false, initialized: false, rulesRequest: 0, asOf: Date.now(), pages: 1, cursor: null, matchVersion: 0, updates: new Map() };
const filteredId = () => byId('watchdog-filter').value;
const report = error => toast.error(error.message || 'Watchdog request failed.');
const interactive = 'button, a, input, select, textarea, [contenteditable="true"]';
function matchParams(asOf = state.asOf) {
    const params = new URLSearchParams({ status: byId('watchdog-status-filter').value,
        archived: String(byId('watchdog-archived').checked), range: byId('watchdog-range-filter').value, asOf: String(asOf) });
    if (filteredId()) params.set('watchdogId', filteredId());
    return params;
}
async function exportMatches(format) {
    const asOf = Date.now();
    const params = matchParams(asOf);
    const selected = state.rules.find(rule => rule.id === Number(filteredId()));
    const filters = { watchdog: { id: selected?.id || null, name: selected?.name || null, status: params.get('status'),
        archived: params.get('archived') === 'true', range: params.get('range'), asOf: new Date(asOf).toISOString() } };
    try {
        const articles = await fetchAllFeedArticles(page => api.watchdogExport(page), params);
        if (!await downloadExport(createFeedExport(format, { articles, filters }))) return;
        toast.success(`Exported ${articles.length.toLocaleString('en-US')} ${articles.length === 1 ? 'article' : 'articles'}.`);
    } catch (error) { toast.error(`Export failed: ${error.message}`); }
}
const button = (text, action, id, className = 'oj-button oj-button-ghost') => {
    const result = node('button', className, text);
    result.type = 'button'; result.dataset.action = action; result.dataset.id = id;
    return result;
};

function renderRules() {
    const list = byId('watchdog-rules');
    const active = document.activeElement;
    const focus = active && list.contains(active) ? active.dataset.watchdogId
        ? { card: active.dataset.watchdogId } : { action: active.dataset.action, id: active.dataset.id } : null;
    const filter = byId('watchdog-filter');
    const selected = filter.value;
    filter.replaceChildren(new Option('Watchdog: All', ''));
    state.rules.forEach(rule => filter.add(new Option(rule.name, String(rule.id))));
    filter.value = state.rules.some(rule => String(rule.id) === selected) ? selected : '';
    syncSelectDropdown(filter);
    const total = state.rules.reduce((sum, rule) => sum + rule.unreadCount, 0);
    const badge = byId('watchdog-nav-badge');
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.hidden = total === 0;
    badge.parentElement.setAttribute('aria-label', total ? `Watchdog, ${total} unread matches` : 'Watchdog');
    byId('watchdog-total').textContent = `${total} unread ${total === 1 ? 'match' : 'matches'}`;
    const all = button('All watchdogs', 'select', '', 'watchdog-all oj-button oj-button-ghost');
    all.setAttribute('aria-pressed', String(!filter.value));
    list.replaceChildren(all);
    if (!state.rules.length) list.append(node('p', 'oj-muted', 'Create a watchdog to follow the stories that matter to you.'));
    for (const rule of state.rules) {
        const card = node('article', 'watchdog-rule oj-panel');
        card.dataset.watchdogId = rule.id; card.tabIndex = 0;
        card.setAttribute('aria-label', `Show matches for ${rule.name}`);
        card.classList.toggle('is-selected', filter.value === String(rule.id));
        const select = button(rule.name, 'select', rule.id, 'watchdog-rule-name');
        select.setAttribute('aria-pressed', String(filter.value === String(rule.id)));
        const status = node('div', 'watchdog-rule-meta');
        status.append(node('span', `oj-tag ${rule.enabled ? 'watchdog-enabled' : ''}`, rule.enabled ? 'Active' : 'Paused'),
            node('span', 'oj-muted', `${rule.unreadCount} unread`));
        const actions = node('div', 'watchdog-actions');
        const edit = button('Edit', 'edit', rule.id);
        edit.setAttribute('aria-label', `Edit ${rule.name}`);
        const toggle = button(rule.enabled ? 'Pause' : 'Activate', 'toggle', rule.id);
        toggle.setAttribute('aria-label', `${rule.enabled ? 'Pause' : 'Activate'} ${rule.name}`);
        const remove = button('Delete', 'delete', rule.id, 'oj-button oj-button-danger');
        remove.setAttribute('aria-label', `Delete ${rule.name}`);
        actions.append(edit, toggle, remove);
        card.append(select, status, actions); list.append(card);
    }
    if (focus) list.querySelector(focus.card ? `[data-watchdog-id="${focus.card}"]` : `[data-action="${focus.action}"][data-id="${focus.id}"]`)?.focus({ preventScroll: true });
}

const visibleMatchState = match => Boolean(match.archivedAt) === byId('watchdog-archived').checked
    && (byId('watchdog-status-filter').value === 'all'
        || Boolean(match.readAt) === (byId('watchdog-status-filter').value === 'read'));

function updateVisibleMatch(match) {
    const loaded = state.matches.some(item => item.id === match.id);
    const update = { readAt: match.readAt, archivedAt: match.archivedAt, version: ++state.matchVersion };
    state.updates.set(match.id, update);
    if (loaded) {
        state.matches = state.matches.map(item => item.id === match.id ? { ...item, readAt: update.readAt, archivedAt: update.archivedAt } : item).filter(visibleMatchState);
        renderMatches();
    }
    return loaded;
}

export async function refreshWatchdogs({ action, id } = {}) {
    const request = ++state.rulesRequest;
    try {
        // Match-state events must not replace an already paginated inbox.
        if (state.active && action === 'match-state') {
            const match = await api.watchdogMatch(id);
            if (!updateVisibleMatch(match)) await loadMatches({ preserve: true });
        }
        const payload = await api.watchdogs();
        if (request !== state.rulesRequest) return;
        state.rules = payload.watchdogs;
        renderRules();
        if (state.active && !['match-state', 'counts', 'notifications'].includes(action)) await loadMatches({ preserve: true, refreshTime: true });
    } catch (error) { report(error); }
}

function renderMatches() {
    const list = byId('watchdog-matches');
    const inbox = byId('watchdog-inbox');
    const scrollTop = inbox.scrollTop;
    const active = document.activeElement;
    const focus = active && list.contains(active) ? active.dataset.matchId
        ? { card: active.dataset.matchId } : { action: active.dataset.action, id: active.dataset.id } : null;
    list.replaceChildren();
    byId('watchdog-state').textContent = state.matches.length ? '' : 'No matches for these filters.';
    for (const match of state.matches) {
        const card = node('article', 'watchdog-match oj-panel');
        card.dataset.matchId = match.id;
        card.tabIndex = 0; card.setAttribute('aria-label', `Open ${match.title || 'Untitled article'}`);
        card.classList.toggle('is-unread', !match.readAt);
        const meta = node('div', 'watchdog-match-meta');
        meta.append(node('span', 'oj-tag', match.watchdogName), node('span', 'oj-muted', match.feedName));
        const date = node('time', 'oj-muted', new Date(match.matchedAt.replace(' ', 'T') + 'Z').toLocaleString());
        date.dateTime = match.matchedAt.replace(' ', 'T') + 'Z'; meta.append(date);
        if (match.historical) meta.append(node('span', 'oj-tag', 'Historical'));
        if (!match.readAt) meta.append(node('span', 'watchdog-unread-label', 'Unread'));
        const heading = node('h2', 'oj-heading-3');
        heading.append(button(match.title || 'Untitled article', 'open', match.id, 'watchdog-match-title'));
        const actions = node('div', 'watchdog-actions');
        actions.append(button(match.readAt ? 'Mark unread' : 'Mark read', 'read', match.id),
            button('Add to list', 'list', match.id),
            button(match.archivedAt ? 'Restore' : 'Archive', 'archive', match.id));
        card.append(meta, heading, node('p', 'watchdog-teaser oj-muted', match.teaser || match.content?.slice(0, 240) || ''), actions);
        list.append(card);
    }
    byId('watchdog-more').hidden = !state.hasMore;
    if (focus) (list.querySelector(focus.card ? `[data-match-id="${focus.card}"]` : `[data-action="${focus.action}"][data-id="${focus.id}"]`) || inbox).focus({ preventScroll: true });
    inbox.scrollTop = scrollTop;
}

async function loadMatches({ append = false, preserve = false, refreshTime = false } = {}) {
    const request = ++state.request;
    const previousPages = state.pages;
    const version = state.matchVersion;
    const targetPages = append ? state.pages + 1 : preserve ? state.pages : 1;
    // Reserve the requested depth before awaiting: an SSE refresh racing with
    // Load more must retain the page the reader has just requested.
    state.pages = targetPages;
    if (!append && (!preserve || refreshTime)) state.asOf = Date.now();
    const params = matchParams();
    if (append && state.cursor) params.set('before', state.cursor);
    state.loading = true; byId('watchdog-more').disabled = true;
    byId('watchdog-results').setAttribute('aria-busy', 'true');
    try {
        const matches = append ? [...state.matches] : [];
        let result, cursor = append ? state.cursor : null, pages = append ? targetPages : 0;
        do {
            result = await api.watchdogMatches(params);
            if (request !== state.request) return;
            matches.push(...result.matches);
            cursor = result.matches.at(-1)?.id || cursor;
            if (!append) pages += 1;
            if (cursor) params.set('before', cursor);
        } while (!append && result.hasMore && pages < targetPages);
        state.matches = [...new Map(matches.map(match => {
            const update = state.updates.get(match.id);
            return [match.id, update?.version > version ? { ...match, readAt: update.readAt, archivedAt: update.archivedAt } : match];
        })).values()].filter(visibleMatchState);
        state.pages = pages;
        state.cursor = cursor;
        state.hasMore = result.hasMore;
        for (const [id, update] of state.updates) if (update.version <= version) state.updates.delete(id);
        renderMatches();
    } catch (error) {
        if (request === state.request) {
            state.pages = previousPages;
            byId('watchdog-state').textContent = `Could not load matches: ${error.message}`;
        }
    }
    finally {
        if (request === state.request) {
            state.loading = false; byId('watchdog-more').disabled = false;
            byId('watchdog-results').setAttribute('aria-busy', 'false');
        }
    }
}

function editRule(rule = null) {
    state.editing = rule?.id || null;
    byId('watchdog-dialog-title').textContent = rule ? 'Edit watchdog' : 'New watchdog';
    byId('watchdog-form').reset();
    byId('watchdog-name').value = rule?.name || '';
    byId('watchdog-enabled').checked = rule?.enabled ?? true;
    for (const field of ['any', 'all', 'exclude']) {
        const key = field === 'exclude' ? field : field === 'any' ? 'includeAny' : 'includeAll';
        byId(`watchdog-${field}`).value = rule?.[key]?.join('\n') || '';
    }
    byId('watchdog-history-row').hidden = Boolean(rule);
    byId('watchdog-form-status').textContent = '';
    const feeds = byId('watchdog-feeds'); feeds.replaceChildren();
    const references = new Map(store.reference.feeds.map(feed => [Number(feed.id), feed.name]));
    for (const id of rule?.feedIds || []) if (!references.has(id)) references.set(id, `Unavailable feed (${id}) — deselect to remove`);
    for (const [id, name] of references) {
        const label = node('label', 'watchdog-checkbox');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = id;
        checkbox.checked = Boolean(rule?.feedIds.includes(id)); label.append(checkbox, document.createTextNode(name)); feeds.append(label);
    }
    if (!references.size) feeds.append(node('p', 'oj-helper', 'Add RSS feeds in Settings. This watchdog will follow all feeds.'));
    openDialog(byId('watchdog-dialog'), { trigger: document.activeElement });
}

async function saveRule(event) {
    event.preventDefault();
    const body = { name: byId('watchdog-name').value.trim(), enabled: byId('watchdog-enabled').checked,
        includeAny: parseWatchdogTerms(byId('watchdog-any').value), includeAll: parseWatchdogTerms(byId('watchdog-all').value),
        exclude: parseWatchdogTerms(byId('watchdog-exclude').value),
        feedIds: [...byId('watchdog-feeds').querySelectorAll('input:checked')].map(input => Number(input.value)) };
    if (!state.editing) body.includeHistory = byId('watchdog-history').checked;
    byId('watchdog-save').disabled = true;
    try {
        const result = state.editing ? await api.updateWatchdog(state.editing, body) : await api.createWatchdog(body);
        closeDialog(byId('watchdog-dialog'));
        await refreshWatchdogs();
        byId('watchdog-rules').querySelector(`[data-action="edit"][data-id="${result.watchdog.id}"]`)?.focus({ preventScroll: true });
        toast.success(result.historicalCount ? `Watchdog saved. ${result.historicalCount} historical matches added without notifications.` : 'Watchdog saved.');
    } catch (error) { byId('watchdog-form-status').textContent = error.message; }
    finally { byId('watchdog-save').disabled = false; }
}

async function ruleAction(event) {
    const action = event.target.closest('button[data-action]');
    if (!action && event.target.closest(interactive)) return;
    const card = event.target.closest('.watchdog-rule');
    const target = action || (card && { dataset: { action: 'select', id: card.dataset.watchdogId } });
    if (!target) return;
    const rule = state.rules.find(item => item.id === Number(target.dataset.id));
    try {
        if (target.dataset.action === 'select') {
            byId('watchdog-filter').value = target.dataset.id; syncSelectDropdown(byId('watchdog-filter'));
            renderRules(); await loadMatches();
        } else if (target.dataset.action === 'edit' && rule) editRule(rule);
        else if (target.dataset.action === 'toggle' && rule) { await api.updateWatchdog(rule.id, { enabled: !rule.enabled }); await refreshWatchdogs(); }
        else if (target.dataset.action === 'delete' && rule) {
            if (!await confirmDialog({ title: 'Delete watchdog?', message: `Delete “${rule.name}” and its matches? Articles remain in your library.`, confirmLabel: 'Delete', cancelLabel: 'Cancel', variant: 'danger' })) return;
            await api.deleteWatchdog(rule.id); await refreshWatchdogs(); byId('watchdog-new').focus();
        }
    } catch (error) { report(error); }
}

async function openMatch(id) {
    const match = await api.watchdogMatch(id);
    updateVisibleMatch(await api.updateWatchdogMatch(id, { read: true }));
    byId('watchdog-article-title').textContent = match.title || 'Untitled article';
    byId('watchdog-article-meta').textContent = `${match.watchdogName} · ${match.feedName}`;
    byId('watchdog-article-content').textContent = match.content || match.teaser || 'No article text stored. Open the original article to read more.';
    const original = byId('watchdog-article-original');
    const url = normalizeArticleUrl(match.url);
    original.disabled = !url;
    original.onclick = () => { if (url) void openBrowser(url).catch(report); };
    openDialog(byId('watchdog-article-dialog'), { trigger: document.activeElement });
    await refreshWatchdogs({ action: 'counts' });
}

async function matchAction(event) {
    const action = event.target.closest('button[data-action]');
    if (!action && event.target.closest(interactive)) return;
    const card = event.target.closest('.watchdog-match');
    const target = action || (card && { dataset: { action: 'open', id: card.dataset.matchId } });
    if (!target) return;
    const match = state.matches.find(item => item.id === Number(target.dataset.id)); if (!match) return;
    try {
        if (target.dataset.action === 'open') await openMatch(match.id);
        else if (target.dataset.action === 'list') await openListModal(match.articleId);
        else {
            const update = target.dataset.action === 'read' ? { read: !match.readAt } : { archived: !match.archivedAt };
            updateVisibleMatch(await api.updateWatchdogMatch(match.id, update));
            await refreshWatchdogs({ action: 'counts' });
        }
    } catch (error) { report(error); }
}

export async function openWatchdogTarget(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    try {
        const match = await api.watchdogMatch(id);
        byId('watchdog-filter').value = String(match.watchdogId);
        byId('watchdog-status-filter').value = 'all';
        byId('watchdog-range-filter').value = 'all';
        byId('watchdog-archived').checked = Boolean(match.archivedAt);
        syncSelectDropdown(byId('watchdog-status-filter'));
        syncSelectDropdown(byId('watchdog-range-filter'));
        await navigate('watchdog');
        await openMatch(id);
    } catch (error) { report(error); }
}
export async function consumeWatchdogTarget() {
    if (isDesktop) {
        const id = await invokeDesktop('watchdog_take_target');
        if (id) await openWatchdogTarget(id);
    } else {
        const target = location.hash.match(/^#watchdog\/(\d+)$/);
        if (target) await openWatchdogTarget(Number(target[1]));
    }
}
export async function initWatchdog() {
    if (state.initialized) return;
    state.initialized = true;
    byId('watchdog-new').addEventListener('click', () => editRule());
    bindExportMenu({ root: byId('watchdog-export-menu'), trigger: byId('watchdog-export-trigger'), popover: byId('watchdog-export-popover'), onSelect: exportMatches });
    byId('watchdog-rules').addEventListener('click', event => { void ruleAction(event); });
    byId('watchdog-matches').addEventListener('click', event => { void matchAction(event); });
    for (const id of ['watchdog-rules', 'watchdog-matches']) byId(id).addEventListener('keydown', event => {
        if (!event.target.matches('.watchdog-rule, .watchdog-match') || !['Enter', ' '].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault(); event.target.click();
    });
    byId('watchdog-form').addEventListener('submit', event => { void saveRule(event); });
    for (const id of ['watchdog-dialog', 'watchdog-article-dialog']) byId(id).addEventListener('close', () => {
        queueMicrotask(() => { if (document.activeElement === document.body) byId('watchdog-new').focus(); });
    });
    byId('watchdog-cancel').addEventListener('click', () => closeDialog(byId('watchdog-dialog')));
    byId('watchdog-close').addEventListener('click', () => closeDialog(byId('watchdog-dialog')));
    byId('watchdog-article-close').addEventListener('click', () => closeDialog(byId('watchdog-article-dialog')));
    byId('watchdog-more').addEventListener('click', () => { void loadMatches({ append: true }); });
    for (const id of ['watchdog-filter', 'watchdog-status-filter', 'watchdog-range-filter', 'watchdog-archived']) {
        byId(id).addEventListener('change', () => { renderRules(); void loadMatches(); });
    }
    window.addEventListener('nbs:watchdog-open', () => { void consumeWatchdogTarget().catch(report); });
    window.addEventListener('hashchange', () => { void consumeWatchdogTarget().catch(report); });
    await refreshWatchdogs();
}
export async function activateWatchdog() {
    state.active = true;
    await refreshWatchdogs();
}
export function deactivateWatchdog() { state.active = false; ++state.request; }
