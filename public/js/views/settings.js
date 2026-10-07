import { api } from '../api/client.js';
import { setBullshitRules, setDigestSettings, setFeeds, setLists, setTopics, store } from '../state/store.js';
import { dom } from '../ui/dom.js';
import { confirmDialog } from '../ui/design-system.js';
import { toast } from '../ui/toast.js';
import { formatDate } from '../utils/format.js';
import { clear, hide, show, text } from '../utils/dom.js';

let initialized = false;
let onReferencesChanged = async () => {};
let onFeedChanged = async () => {};
let onDigestChanged = () => {};

function actionButton(label, action, icon, variant = 'ghost') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn ${variant} oj-button oj-button-${variant} oj-button-compact`;
    button.dataset.action = action;
    const symbol = document.createElement('i');
    symbol.className = `fa-solid fa-${icon}`;
    symbol.setAttribute('aria-hidden', 'true');
    button.append(symbol, document.createTextNode(` ${label}`));
    return button;
}

function resetFeedForm() {
    store.settings.feedEditingId = null;
    dom.settings.feedForm.reset(); text(dom.settings.feedSubmit, 'Feed speichern'); text(dom.settings.feedStatus, '');
}
function resetListForm() {
    store.settings.listEditingId = null;
    dom.settings.listForm.reset(); dom.settings.listColor.value = '#1d1d1f'; text(dom.settings.listSubmit, 'Save list'); text(dom.settings.listStatus, '');
}
function resetTopicForm() {
    store.settings.topicEditingSlug = null;
    dom.settings.topicForm.reset(); text(dom.settings.topicSubmit, 'save topic'); text(dom.settings.topicStatus, '');
}
function resetBullshitRuleForm() {
    store.settings.bullshitRuleEditingId = null;
    dom.settings.bullshitForm.reset();
    dom.settings.bullshitEnabled.checked = true;
    text(dom.settings.bullshitSubmit, '+ Add rule');
    text(dom.settings.bullshitFormStatus, '');
}

function renderFeeds() {
    const visibleFeeds = store.reference.feeds.filter(feed => !feed.manual);
    const fragment = document.createDocumentFragment();
    for (const feed of visibleFeeds) {
        const node = dom.settings.feedTemplate.content.cloneNode(true);
        const root = node.querySelector('.list-item'); root.dataset.feedId = String(feed.id);
        const logo = node.querySelector('.feed-logo');
        if (feed.logoDataUrl) { logo.src = feed.logoDataUrl; show(logo); } else hide(logo);
        text(node.querySelector('.feed-name'), feed.name); text(node.querySelector('.list-meta'), `${feed.websiteUrl} · ${feed.feedUrl}`);
        node.querySelector('.btn-edit').dataset.action = 'edit-feed'; node.querySelector('.btn-delete').dataset.action = 'delete-feed'; fragment.appendChild(node);
    }
    dom.settings.feedsList.replaceChildren(fragment);
    text(dom.settings.feedsState, visibleFeeds.length ? '' : 'No feeds yet.');
    dom.settings.feedsState.classList.toggle('hide', visibleFeeds.length > 0);
}

function renderLists() {
    const fragment = document.createDocumentFragment();
    for (const list of store.reference.lists) {
        const node = dom.settings.listTemplate.content.cloneNode(true);
        const root = node.querySelector('.list-item'); root.dataset.listId = String(list.id);
        text(node.querySelector('.list-name'), list.name); text(node.querySelector('.list-meta'), list.description || '');
        node.querySelector('.list-color-dot').style.background = list.color || '#1d1d1f';
        node.querySelector('.btn-edit').dataset.action = 'edit-list'; node.querySelector('.btn-delete').dataset.action = 'delete-list'; fragment.appendChild(node);
    }
    dom.settings.listsList.replaceChildren(fragment);
    text(dom.settings.listsState, store.reference.lists.length ? '' : 'No lists yet.');
    dom.settings.listsState.classList.toggle('hide', store.reference.lists.length > 0);
}

function renderTopics() {
    const fragment = document.createDocumentFragment();
    for (const topic of store.reference.topics) {
        const item = document.createElement('div'); item.className = 'list-item settings-topic-item oj-list-item'; item.dataset.topicSlug = topic.slug;
        const main = document.createElement('div'); main.className = 'settings-topic-item-main';
        const title = document.createElement('div'); title.className = 'settings-topic-item-title';
        const label = document.createElement('span'); label.textContent = topic.label || topic.slug;
        const slug = document.createElement('span'); slug.className = 'settings-topic-item-slug oj-badge oj-mono'; slug.textContent = topic.slug;
        const meta = document.createElement('div'); meta.className = 'settings-topic-item-meta oj-muted oj-mono'; meta.textContent = `strong: ${(topic.strong || []).length} · medium: ${(topic.medium || []).length} · weak: ${(topic.weak || []).length}`;
        title.append(label, slug); main.append(title, meta);
        const actions = document.createElement('div'); actions.className = 'list-actions';
        const edit = actionButton('Edit', 'edit-topic', 'pen');
        const remove = actionButton('Remove', 'delete-topic', 'trash', 'danger');
        actions.append(edit, remove); item.append(main, actions); fragment.appendChild(item);
    }
    dom.settings.topicsList.replaceChildren(fragment);
    text(dom.settings.topicsState, store.reference.topics.length ? '' : 'No topics configured yet.');
    dom.settings.topicsState.classList.toggle('hide', store.reference.topics.length > 0);
}

const bullshitFieldLabels = Object.freeze({ title: 'Title', teaser: 'Teaser', url: 'URL', source: 'Source' });
const bullshitOperatorLabels = Object.freeze({ contains: 'Contains', not_contains: 'Does not contain', equals: 'Equals', regex: 'Regex' });

function renderBullshitRules() {
    const fragment = document.createDocumentFragment();
    for (const rule of store.reference.bullshitRules) {
        const item = document.createElement('div'); item.className = 'list-item settings-bullshit-item oj-list-item'; item.dataset.ruleId = String(rule.id);
        const main = document.createElement('div');
        const title = document.createElement('div'); title.className = 'settings-bullshit-item-title'; title.textContent = rule.name;
        const meta = document.createElement('div'); meta.className = 'settings-bullshit-item-meta oj-muted';
        meta.textContent = `${bullshitFieldLabels[rule.field] || rule.field} · ${bullshitOperatorLabels[rule.operator] || rule.operator} · ${rule.value}`;
        main.append(title, meta);
        const actions = document.createElement('div'); actions.className = 'list-actions';
        const enabled = document.createElement('label'); enabled.className = 'settings-bullshit-enabled oj-switch';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.role = 'switch'; checkbox.checked = Boolean(rule.enabled); checkbox.dataset.action = 'toggle-bullshit-rule';
        const track = document.createElement('span'); track.className = 'oj-switch-track'; track.setAttribute('aria-hidden', 'true');
        const enabledText = document.createElement('span'); enabledText.textContent = 'Enabled'; enabled.append(checkbox, track, enabledText);
        const edit = actionButton('Edit', 'edit-bullshit-rule', 'pen');
        const remove = actionButton('Delete', 'delete-bullshit-rule', 'trash', 'danger');
        actions.append(enabled, edit, remove); item.append(main, actions); fragment.appendChild(item);
    }
    dom.settings.bullshitList.replaceChildren(fragment);
    const empty = store.reference.bullshitRules.length === 0;
    text(dom.settings.bullshitState, empty ? 'No bullshit rules yet. Create rules to automatically identify noisy or unwanted articles.' : '');
    dom.settings.bullshitState.classList.toggle('hide', !empty);
}

function renderDigestSettings() {
    const excluded = new Set(store.reference.digestSettings.excludedFeedIds.map(Number));
    const feeds = document.createDocumentFragment();
    for (const feed of store.reference.feeds) {
        const row = document.createElement('label'); row.className = 'settings-digest-feed-item oj-list-item oj-check';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'oj-checkbox'; checkbox.dataset.feedId = String(feed.id); checkbox.checked = excluded.has(Number(feed.id));
        const wrap = document.createElement('span'); wrap.className = 'settings-digest-feed-item-text';
        const title = document.createElement('span'); title.className = 'settings-digest-feed-item-title'; title.textContent = feed.name || 'Unnamed feed';
        const meta = document.createElement('span'); meta.className = 'settings-digest-feed-item-meta oj-muted oj-mono'; meta.textContent = feed.manual ? 'Imported links' : (feed.feedUrl || feed.websiteUrl || '');
        wrap.append(title, meta); row.append(checkbox, wrap); feeds.appendChild(row);
    }
    if (!store.reference.feeds.length) { const empty = document.createElement('div'); empty.className = 'state oj-empty-state'; empty.textContent = 'No feeds yet.'; feeds.appendChild(empty); }
    dom.settings.digestFeedsList.replaceChildren(feeds);

    const words = document.createDocumentFragment();
    for (const item of store.reference.digestSettings.blockedWords) {
        const row = document.createElement('div'); row.className = 'settings-digest-word-item oj-list-item'; row.dataset.wordId = String(item.id);
        const label = document.createElement('span'); label.className = 'settings-digest-word-label'; label.textContent = item.word;
        const remove = actionButton('Remove', 'delete-word', 'trash', 'danger');
        row.append(label, remove); words.appendChild(row);
    }
    if (!store.reference.digestSettings.blockedWords.length) { const empty = document.createElement('div'); empty.className = 'state oj-empty-state'; empty.textContent = 'No blocked words yet.'; words.appendChild(empty); }
    dom.settings.blockedWordsList.replaceChildren(words);
}

export function refreshSettingsReferences() {
    if (!initialized) return;
    renderFeeds(); renderLists(); renderTopics(); renderBullshitRules(); renderDigestSettings();
}

async function reloadFeeds() { setFeeds(await api.feeds()); refreshSettingsReferences(); await onReferencesChanged(); }
async function reloadLists() { setLists(await api.lists()); refreshSettingsReferences(); await onReferencesChanged(); }
async function reloadTopics() { const payload = await api.topics(); setTopics(payload?.topics); refreshSettingsReferences(); await onReferencesChanged(); }
export async function reloadBullshitRules() { setBullshitRules(await api.bullshitRules()); if (initialized) renderBullshitRules(); }

async function loadSettingsOnlyData() {
    const [digestResult, rulesResult, statusResult, statsResult, bullshitResult] = await Promise.allSettled([api.digestSettings(), api.topicRules(), api.fetchStatus(), api.articleStats(), api.bullshitRules()]);
    if (digestResult.status === 'fulfilled') { setDigestSettings(digestResult.value); renderDigestSettings(); }
    else text(dom.settings.digestFeedsState, `Error: ${digestResult.reason.message}`);
    if (rulesResult.status === 'fulfilled') dom.settings.topicsJson.value = rulesResult.value?.raw || JSON.stringify(rulesResult.value?.rules || {}, null, 2);
    else text(dom.settings.topicsJsonStatus, `Error: ${rulesResult.reason.message}`);
    if (statusResult.status === 'fulfilled') {
        const value = statusResult.value;
        text(dom.settings.fetchStatus, value?.at ? `Last fetch: ${formatDate(value.at)}${value.error ? ` (Error: ${value.error})` : ` (${value.totalNew} new)`}` : 'Last fetch: —');
    }
    if (statsResult.status === 'fulfilled') text(dom.settings.articleCount, `Saved articles: ${Number(statsResult.value?.total || 0).toLocaleString('de-DE')}`);
    if (bullshitResult.status === 'fulfilled') { setBullshitRules(bullshitResult.value); renderBullshitRules(); }
    else text(dom.settings.bullshitState, `Error: ${bullshitResult.reason.message}`);
}

export async function reloadDigestSettings() {
    setDigestSettings(await api.digestSettings());
    if (initialized) renderDigestSettings();
}

export async function reloadTopicRules() {
    if (!initialized) return;
    const rules = await api.topicRules();
    dom.settings.topicsJson.value = rules?.raw || JSON.stringify(rules?.rules || {}, null, 2);
}

export async function refreshSettingsMeta() {
    if (!initialized) return;
    const [status, stats] = await Promise.all([api.fetchStatus(), api.articleStats()]);
    text(dom.settings.fetchStatus, status?.at ? `Last fetch: ${formatDate(status.at)}${status.error ? ` (Error: ${status.error})` : ` (${status.totalNew} new)`}` : 'Last fetch: —');
    text(dom.settings.articleCount, `Saved articles: ${Number(stats?.total || 0).toLocaleString('de-DE')}`);
}

function topicPayload() {
    const split = value => String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    return { slug: dom.settings.topicSlug.value.trim(), label: dom.settings.topicLabel.value.trim(), strong: split(dom.settings.topicStrong.value), medium: split(dom.settings.topicMedium.value), weak: split(dom.settings.topicWeak.value) };
}

function bullshitRulePayload() {
    return {
        name: dom.settings.bullshitName.value.trim(),
        field: dom.settings.bullshitField.value,
        operator: dom.settings.bullshitOperator.value,
        value: dom.settings.bullshitValue.value.trim(),
        enabled: dom.settings.bullshitEnabled.checked,
    };
}

function bullshitReevaluationText(result) {
    const value = result?.reEvaluation || result || {};
    const articleCount = Number(value.matchedArticles || 0);
    const ruleCount = Number(value.matchedRules || 0);
    return `${articleCount.toLocaleString('en-US')} ${articleCount === 1 ? 'article' : 'articles'} matched ${ruleCount.toLocaleString('en-US')} bullshit ${ruleCount === 1 ? 'rule' : 'rules'}`;
}

function confirmDeletion(type, label) {
    return confirmDialog({
        title: `Delete ${type}?`,
        message: `Delete ${type} "${label}"?`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        variant: 'danger',
    });
}

function bindTabs() {
    dom.settings.tabRoot.addEventListener('oj:change', event => {
        if (event.target !== dom.settings.tabRoot) return;
        const { tab, panel: activePanel } = event.detail;
        dom.settings.tabButtons.forEach(item => {
            item.classList.toggle('is-active', item === tab);
        });
        dom.settings.panels.forEach(panel => panel.classList.toggle('is-active', panel === activePanel));
    });
}

function bindFeedActions() {
    dom.settings.feedForm.addEventListener('submit', async event => {
        event.preventDefault(); dom.settings.feedSubmit.disabled = true; text(dom.settings.feedStatus, 'Saving…');
        const payload = { name: dom.settings.feedName.value.trim(), websiteUrl: dom.settings.feedWebsite.value.trim(), feedUrl: dom.settings.feedUrl.value.trim() };
        try { if (store.settings.feedEditingId) await api.updateFeed(store.settings.feedEditingId, payload); else await api.createFeed(payload); resetFeedForm(); await reloadFeeds(); await onFeedChanged(); }
        catch (error) { text(dom.settings.feedStatus, `Error: ${error.message}`); }
        finally { dom.settings.feedSubmit.disabled = false; }
    });
    dom.settings.feedCancel.addEventListener('click', resetFeedForm);
    dom.settings.feedTest.addEventListener('click', async () => {
        const url = dom.settings.feedUrl.value.trim(); if (!url) { text(dom.settings.feedStatus, 'Please enter a feed URL.'); return; }
        dom.settings.feedTest.disabled = true; text(dom.settings.feedStatus, 'Testing feed…');
        try { const result = await api.testFeed(url); text(dom.settings.feedStatus, `OK: ${result.itemCount} Items. ${result.sampleTitles?.length ? `Examples: ${result.sampleTitles.join(' · ')}` : ''}`); }
        catch (error) { text(dom.settings.feedStatus, `Error: ${error.message}`); }
        finally { dom.settings.feedTest.disabled = false; }
    });
    dom.settings.feedsList.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]'); const id = Number(action?.closest('[data-feed-id]')?.dataset.feedId); const feed = store.reference.feedsById.get(id); if (!action || !feed) return;
        if (action.dataset.action === 'edit-feed') { store.settings.feedEditingId = id; dom.settings.feedName.value = feed.name; dom.settings.feedWebsite.value = feed.websiteUrl; dom.settings.feedUrl.value = feed.feedUrl; text(dom.settings.feedSubmit, 'Save changes'); text(dom.settings.feedStatus, 'Edit mode active.'); }
        if (action.dataset.action === 'delete-feed' && await confirmDeletion('feed', feed.name)) { try { await api.deleteFeed(id); await reloadFeeds(); await onFeedChanged(); } catch (error) { toast.error(error.message); } }
    });
}

function bindListActions() {
    dom.settings.listForm.addEventListener('submit', async event => {
        event.preventDefault(); dom.settings.listSubmit.disabled = true; text(dom.settings.listStatus, 'Saving…');
        const payload = { name: dom.settings.listName.value.trim(), description: dom.settings.listDescription.value.trim(), color: dom.settings.listColor.value || '#1d1d1f' };
        try { if (store.settings.listEditingId) await api.updateList(store.settings.listEditingId, payload); else await api.createList(payload); resetListForm(); await reloadLists(); }
        catch (error) { text(dom.settings.listStatus, `Error: ${error.message}`); }
        finally { dom.settings.listSubmit.disabled = false; }
    });
    dom.settings.listCancel.addEventListener('click', resetListForm);
    dom.settings.listsList.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]'); const id = Number(action?.closest('[data-list-id]')?.dataset.listId); const list = store.reference.listsById.get(id); if (!action || !list) return;
        if (action.dataset.action === 'edit-list') { store.settings.listEditingId = id; dom.settings.listName.value = list.name; dom.settings.listDescription.value = list.description || ''; dom.settings.listColor.value = list.color || '#1d1d1f'; text(dom.settings.listSubmit, 'Save changes'); text(dom.settings.listStatus, 'Edit mode active.'); }
        if (action.dataset.action === 'delete-list' && await confirmDeletion('list', list.name)) { try { await api.deleteList(id); await reloadLists(); } catch (error) { toast.error(error.message); } }
    });
}

function bindTopicActions() {
    dom.settings.topicForm.addEventListener('submit', async event => {
        event.preventDefault(); const payload = topicPayload(); if (!payload.slug || !payload.label) { text(dom.settings.topicStatus, 'Slug and label are required.'); return; }
        dom.settings.topicSubmit.disabled = true; text(dom.settings.topicStatus, 'Saving…');
        try { if (store.settings.topicEditingSlug) await api.updateTopic(store.settings.topicEditingSlug, payload); else await api.createTopic(payload); resetTopicForm(); await reloadTopics(); const rules = await api.topicRules(); dom.settings.topicsJson.value = rules?.raw || ''; }
        catch (error) { text(dom.settings.topicStatus, `Error: ${error.message}`); }
        finally { dom.settings.topicSubmit.disabled = false; }
    });
    dom.settings.topicCancel.addEventListener('click', resetTopicForm);
    dom.settings.topicsList.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]'); const slug = action?.closest('[data-topic-slug]')?.dataset.topicSlug; const topic = store.reference.topicsBySlug.get(slug); if (!action || !topic) return;
        if (action.dataset.action === 'edit-topic') { store.settings.topicEditingSlug = slug; dom.settings.topicSlug.value = topic.slug; dom.settings.topicLabel.value = topic.label; dom.settings.topicStrong.value = (topic.strong || []).join('\n'); dom.settings.topicMedium.value = (topic.medium || []).join('\n'); dom.settings.topicWeak.value = (topic.weak || []).join('\n'); text(dom.settings.topicSubmit, 'save changes'); text(dom.settings.topicStatus, `Editing topic: ${slug}`); }
        if (action.dataset.action === 'delete-topic' && await confirmDeletion('topic', topic.label || slug)) { try { await api.deleteTopic(slug); resetTopicForm(); await reloadTopics(); const rules = await api.topicRules(); dom.settings.topicsJson.value = rules?.raw || ''; } catch (error) { toast.error(error.message); } }
    });
    dom.settings.topicsValidate.addEventListener('click', async () => { const label = dom.settings.topicsValidate.textContent; dom.settings.topicsValidate.disabled = true; try { const result = await api.validateTopics(dom.settings.topicsJson.value); text(dom.settings.topicsJsonStatus, `Valid (${result.topicCount} topic${result.topicCount === 1 ? '' : 's'})`); } catch (error) { text(dom.settings.topicsJsonStatus, `Invalid JSON: ${error.message}`); } finally { dom.settings.topicsValidate.disabled = false; text(dom.settings.topicsValidate, label); } });
    dom.settings.topicsSave.addEventListener('click', async () => { dom.settings.topicsSave.disabled = true; try { const result = await api.saveTopicRules(dom.settings.topicsJson.value); dom.settings.topicsJson.value = result?.raw || dom.settings.topicsJson.value; await reloadTopics(); text(dom.settings.topicsJsonStatus, `Saved (${result?.topics?.length || 0} topics)`); } catch (error) { text(dom.settings.topicsJsonStatus, `Error: ${error.message}`); } finally { dom.settings.topicsSave.disabled = false; } });
    dom.settings.topicsReprocess.addEventListener('click', async () => { dom.settings.topicsReprocess.disabled = true; text(dom.settings.topicsReprocessStatus, 'Reprocessing…'); try { const result = await api.reprocessTopics(); text(dom.settings.topicsReprocessStatus, ['Done: ', result.processed, ' processed · ', result.assignedArticles, ' with topics · ', result.topicAssignments, ' assignments'].join('')); } catch (error) { text(dom.settings.topicsReprocessStatus, `Error: ${error.message}`); } finally { dom.settings.topicsReprocess.disabled = false; } });
}

function bindBullshitRuleActions() {
    dom.settings.bullshitForm.addEventListener('submit', async event => {
        event.preventDefault();
        const payload = bullshitRulePayload();
        if (!payload.name || !payload.value) { text(dom.settings.bullshitFormStatus, 'Name and value are required.'); return; }
        if (payload.operator === 'regex') {
            try { new RegExp(payload.value, 'iu'); }
            catch { text(dom.settings.bullshitFormStatus, 'Invalid regular expression.'); return; }
        }
        dom.settings.bullshitSubmit.disabled = true;
        text(dom.settings.bullshitFormStatus, 'Re-evaluating articles…');
        try {
            const result = store.settings.bullshitRuleEditingId
                ? await api.updateBullshitRule(store.settings.bullshitRuleEditingId, payload)
                : await api.createBullshitRule(payload);
            resetBullshitRuleForm();
            await reloadBullshitRules();
            text(dom.settings.bullshitFormStatus, bullshitReevaluationText(result));
            await onFeedChanged();
        } catch (error) {
            text(dom.settings.bullshitFormStatus, `Error: ${error.message}`);
        } finally {
            dom.settings.bullshitSubmit.disabled = false;
        }
    });
    dom.settings.bullshitCancel.addEventListener('click', resetBullshitRuleForm);
    dom.settings.bullshitList.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]');
        const id = Number(action?.closest('[data-rule-id]')?.dataset.ruleId);
        const rule = store.reference.bullshitRulesById.get(id);
        if (!action || !rule || action.dataset.action === 'toggle-bullshit-rule') return;
        if (action.dataset.action === 'edit-bullshit-rule') {
            store.settings.bullshitRuleEditingId = id;
            dom.settings.bullshitName.value = rule.name;
            dom.settings.bullshitField.value = rule.field;
            dom.settings.bullshitOperator.value = rule.operator;
            dom.settings.bullshitValue.value = rule.value;
            dom.settings.bullshitEnabled.checked = Boolean(rule.enabled);
            text(dom.settings.bullshitSubmit, 'Save changes');
            text(dom.settings.bullshitFormStatus, `Editing rule: ${rule.name}`);
        }
        if (action.dataset.action === 'delete-bullshit-rule' && await confirmDeletion('rule', rule.name)) {
            action.disabled = true; text(dom.settings.bullshitReevaluateStatus, 'Re-evaluating articles…');
            try {
                const result = await api.deleteBullshitRule(id);
                if (store.settings.bullshitRuleEditingId === id) resetBullshitRuleForm();
                await reloadBullshitRules();
                text(dom.settings.bullshitReevaluateStatus, bullshitReevaluationText(result));
                await onFeedChanged();
            } catch (error) { action.disabled = false; toast.error(error.message); }
        }
    });
    dom.settings.bullshitList.addEventListener('change', async event => {
        const checkbox = event.target.closest('[data-action="toggle-bullshit-rule"]');
        const id = Number(checkbox?.closest('[data-rule-id]')?.dataset.ruleId);
        if (!checkbox || !id) return;
        checkbox.disabled = true; text(dom.settings.bullshitReevaluateStatus, 'Re-evaluating articles…');
        try {
            const result = await api.updateBullshitRule(id, { enabled: checkbox.checked });
            await reloadBullshitRules();
            text(dom.settings.bullshitReevaluateStatus, bullshitReevaluationText(result));
            await onFeedChanged();
        } catch (error) {
            checkbox.checked = !checkbox.checked; checkbox.disabled = false; toast.error(error.message);
        }
    });
    dom.settings.bullshitReevaluate.addEventListener('click', async () => {
        dom.settings.bullshitReevaluate.disabled = true; text(dom.settings.bullshitReevaluateStatus, 'Re-evaluating articles…');
        try {
            const result = await api.reevaluateBullshitRules();
            text(dom.settings.bullshitReevaluateStatus, bullshitReevaluationText(result));
            await onFeedChanged();
        } catch (error) { text(dom.settings.bullshitReevaluateStatus, `Error: ${error.message}`); }
        finally { dom.settings.bullshitReevaluate.disabled = false; }
    });
}

function bindDigestSettings() {
    dom.settings.digestFeedsSave.addEventListener('click', async () => {
        const ids = [...dom.settings.digestFeedsList.querySelectorAll('[data-feed-id]:checked')].map(input => Number(input.dataset.feedId)); dom.settings.digestFeedsSave.disabled = true;
        try { setDigestSettings(await api.saveExcludedFeeds(ids)); renderDigestSettings(); onDigestChanged(); text(dom.settings.digestFeedsState, `Saved (${ids.length} excluded).`); }
        catch (error) { text(dom.settings.digestFeedsState, `Error: ${error.message}`); }
        finally { dom.settings.digestFeedsSave.disabled = false; }
    });
    const addWord = async () => { const word = dom.settings.blockedWordInput.value.trim().replace(/\s+/g, ' ').slice(0, 120); if (word.length < 2) { text(dom.settings.blockedWordsState, 'Please enter at least 2 characters.'); return; } dom.settings.blockedWordAdd.disabled = true; try { await api.addBlockedWord(word); dom.settings.blockedWordInput.value = ''; setDigestSettings(await api.digestSettings()); renderDigestSettings(); onDigestChanged(); } catch (error) { text(dom.settings.blockedWordsState, `Error: ${error.message}`); } finally { dom.settings.blockedWordAdd.disabled = false; } };
    dom.settings.blockedWordAdd.addEventListener('click', addWord);
    dom.settings.blockedWordInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void addWord(); } });
    dom.settings.blockedWordsList.addEventListener('click', async event => { const button = event.target.closest('[data-action="delete-word"]'); const id = Number(button?.closest('[data-word-id]')?.dataset.wordId); if (!id) return; button.disabled = true; try { await api.deleteBlockedWord(id); setDigestSettings(await api.digestSettings()); renderDigestSettings(); onDigestChanged(); } catch (error) { button.disabled = false; toast.error(error.message); } });
}

function bindFetch() {
    dom.settings.fetchNow.addEventListener('click', async () => { const label = dom.settings.fetchNow.textContent; dom.settings.fetchNow.disabled = true; text(dom.settings.fetchNow, 'fetching…'); try { await api.runFetch(); await onFeedChanged(); onDigestChanged(); await loadSettingsOnlyData(); } catch (error) { toast.error(`Fetch failed: ${error.message}`); } finally { dom.settings.fetchNow.disabled = false; text(dom.settings.fetchNow, label); } });
}

export async function initSettings(options = {}) {
    if (initialized) return;
    initialized = true; store.settings.initialized = true;
    onReferencesChanged = options.onReferencesChanged || onReferencesChanged; onFeedChanged = options.onFeedChanged || onFeedChanged; onDigestChanged = options.onDigestChanged || onDigestChanged;
    bindTabs(); bindFeedActions(); bindListActions(); bindTopicActions(); bindBullshitRuleActions(); bindDigestSettings(); bindFetch();
    refreshSettingsReferences(); await loadSettingsOnlyData();
}

export async function activateSettings(options) { if (!initialized) await initSettings(options); }
export function deactivateSettings() {}
