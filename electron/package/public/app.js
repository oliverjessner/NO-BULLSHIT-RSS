const state = {
    feeds: [],
    lists: [],
    editingId: null,
};

const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-link');
const articlesState = document.getElementById('articles-state');
const articlesList = document.getElementById('articles-list');
const feedsState = document.getElementById('feeds-state');
const feedsList = document.getElementById('feeds-list');
const filterList = document.getElementById('filter-list');
const filterSource = document.getElementById('filter-source');
const refreshArticlesBtn = document.getElementById('refresh-articles');
const runFetchBtn = document.getElementById('run-fetch');
const toggleLayoutBtn = document.getElementById('toggle-layout');
const fetchStatus = document.getElementById('fetch-status');
const searchInput = document.getElementById('search-input');
const loadingRow = document.getElementById('loading-row');
const feedForm = document.getElementById('feed-form');
const feedName = document.getElementById('feed-name');
const feedWebsite = document.getElementById('feed-website');
const feedUrl = document.getElementById('feed-url');
const feedSubmit = document.getElementById('feed-submit');
const feedCancel = document.getElementById('feed-cancel');
const feedTest = document.getElementById('feed-test');
const feedFormStatus = document.getElementById('feed-form-status');
const listForm = document.getElementById('list-form');
const listName = document.getElementById('list-name');
const listDescription = document.getElementById('list-description');
const listColor = document.getElementById('list-color');
const listSubmit = document.getElementById('list-submit');
const listCancel = document.getElementById('list-cancel');
const listFormStatus = document.getElementById('list-form-status');
const listsState = document.getElementById('lists-state');
const listsList = document.getElementById('lists-list');
const settingsTabs = document.querySelectorAll('.settings-tab');
const settingsPanels = document.querySelectorAll('.settings-panel');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalListSelect = document.getElementById('modal-list-select');
const modalClose = document.getElementById('modal-close');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');
const modalExistingLists = document.getElementById('modal-existing-lists');
const LAYOUT_KEY = 'fnnd.layout';

let loadingStartedAt = 0;
let isListLayout = localStorage.getItem(LAYOUT_KEY) === 'list';
let searchTimer = null;
let listEditingId = null;
let pendingArticleId = null;
let sse = null;

function setView(name) {
    views.forEach(view => {
        view.classList.toggle('is-active', view.id === `view-${name}`);
    });
    navLinks.forEach(link => {
        link.classList.toggle('is-active', link.dataset.view === name);
    });
}

navLinks.forEach(link => {
    link.addEventListener('click', () => setView(link.dataset.view));
});

settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        settingsTabs.forEach(button => {
            button.classList.toggle('is-active', button === tab);
        });
        settingsPanels.forEach(panel => {
            panel.classList.toggle('is-active', panel.id === `settings-${tab.dataset.settings}`);
        });
    });
});

function applyLayoutState() {
    articlesList.classList.toggle('is-list', isListLayout);
    toggleLayoutBtn.classList.toggle('is-on', isListLayout);
    toggleLayoutBtn.dataset.layout = isListLayout ? 'list' : 'cards';
    toggleLayoutBtn.setAttribute('aria-pressed', String(isListLayout));
    const label = toggleLayoutBtn.querySelector('.toggle-label');
    if (label) {
        label.textContent = isListLayout ? 'Liste' : 'Cards';
    }
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadFetchStatus() {
    try {
        const status = await apiFetch('/api/fetch/status');
        if (!status || !status.at) {
            fetchStatus.textContent = 'Letzter Fetch: —';
            return;
        }
        const date = formatDate(status.at);
        const suffix = status.error ? ` (Fehler: ${status.error})` : ` (${status.totalNew} neu)`;
        fetchStatus.textContent = `Letzter Fetch: ${date}${suffix}`;
    } catch {
        fetchStatus.textContent = 'Letzter Fetch: —';
    }
}

function setStatus(element, message) {
    element.textContent = message || '';
}

async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const error = body.error || 'Server error';
        throw new Error(error);
    }
    if (res.status === 204) return null;
    return res.json();
}

function renderFeeds() {
    feedsList.innerHTML = '';

    if (state.feeds.length === 0) {
        feedsState.textContent = 'Noch keine Feeds vorhanden.';
        feedsState.style.display = 'block';
        return;
    }

    feedsState.style.display = 'none';

    const template = document.getElementById('feed-item-template');
    state.feeds.forEach(feed => {
        const node = template.content.cloneNode(true);
        const logoEl = node.querySelector('.feed-logo');
        const nameEl = node.querySelector('.feed-name');
        if (feed.logoDataUrl) {
            logoEl.src = feed.logoDataUrl;
            logoEl.style.display = 'inline-block';
        } else {
            logoEl.style.display = 'none';
        }
        nameEl.textContent = feed.name;
        node.querySelector('.list-meta').textContent = `${feed.websiteUrl} · ${feed.feedUrl}`;

        node.querySelector('.btn-edit').addEventListener('click', () => {
            state.editingId = feed.id;
            feedName.value = feed.name;
            feedWebsite.value = feed.websiteUrl;
            feedUrl.value = feed.feedUrl;
            feedSubmit.textContent = 'Änderungen speichern';
            setStatus(feedFormStatus, 'Bearbeitungsmodus aktiv.');
        });

        node.querySelector('.btn-delete').addEventListener('click', async () => {
            if (!confirm(`Feed "${feed.name}" löschen?`)) return;
            try {
                await apiFetch(`/api/feeds/${feed.id}`, { method: 'DELETE' });
                await loadFeeds();
                await loadArticles();
            } catch (err) {
                alert(err.message);
            }
        });

        feedsList.appendChild(node);
    });
}

function renderLists() {
    listsList.innerHTML = '';

    if (state.lists.length === 0) {
        listsState.textContent = 'Noch keine Listen vorhanden.';
        listsState.style.display = 'block';
        return;
    }

    listsState.style.display = 'none';
    const template = document.getElementById('list-item-template');

    state.lists.forEach(list => {
        const node = template.content.cloneNode(true);
        const nameEl = node.querySelector('.list-name');
        const dotEl = node.querySelector('.list-color-dot');
        if (nameEl) {
            nameEl.textContent = list.name;
        }
        if (dotEl) {
            dotEl.style.background = list.color || '#1d1d1f';
        }
        node.querySelector('.list-meta').textContent = list.description || '';

        node.querySelector('.btn-edit').addEventListener('click', () => {
            listEditingId = list.id;
            listName.value = list.name;
            listDescription.value = list.description || '';
            listColor.value = list.color || '#1d1d1f';
            listSubmit.textContent = 'Änderungen speichern';
            setStatus(listFormStatus, 'Bearbeitungsmodus aktiv.');
        });

        node.querySelector('.btn-delete').addEventListener('click', async () => {
            if (!confirm(`Liste "${list.name}" löschen?`)) {
                return;
            }
            try {
                await apiFetch(`/api/lists/${list.id}`, { method: 'DELETE' });
                await loadLists();
            } catch (err) {
                alert(err.message);
            }
        });

        listsList.appendChild(node);
    });
}

async function openListModal(articleId) {
    pendingArticleId = articleId;
    modalListSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Liste auswählen';
    modalListSelect.appendChild(placeholder);

    let existingIds = new Set();
    let existingLists = [];
    try {
        existingLists = await apiFetch(`/api/articles/${articleId}/lists`);
        existingIds = new Set(existingLists.map(item => String(item.id)));
    } catch (err) {
        existingIds = new Set();
        existingLists = [];
    }

    state.lists.forEach(list => {
        const option = document.createElement('option');
        option.value = list.id;
        option.textContent = existingIds.has(String(list.id)) ? `${list.name} (bereits)` : list.name;
        option.disabled = existingIds.has(String(list.id));
        modalListSelect.appendChild(option);
    });

    if (modalExistingLists) {
        modalExistingLists.innerHTML = '';
        if (existingLists.length === 0) {
            modalExistingLists.textContent = '—';
        } else {
            existingLists.forEach(item => {
                const chip = document.createElement('span');
                chip.className = 'modal-chip';
                const dot = document.createElement('span');
                dot.className = 'modal-chip-dot';
                dot.style.background = item.color || '#1d1d1f';
                const text = document.createElement('span');
                text.textContent = item.name;
                chip.appendChild(dot);
                chip.appendChild(text);
                modalExistingLists.appendChild(chip);
            });
        }
    }

    modalBackdrop.classList.add('is-open');
    modalBackdrop.setAttribute('aria-hidden', 'false');
}

function closeListModal() {
    pendingArticleId = null;
    modalBackdrop.classList.remove('is-open');
    modalBackdrop.setAttribute('aria-hidden', 'true');
}

function resetListForm() {
    listEditingId = null;
    listName.value = '';
    listDescription.value = '';
    listColor.value = '#1d1d1f';
    listSubmit.textContent = 'Liste speichern';
    setStatus(listFormStatus, '');
}

async function loadLists() {
    listsState.style.display = 'block';
    listsState.textContent = 'Lädt…';
    try {
        state.lists = await apiFetch('/api/lists');
        renderLists();
        renderListFilterOptions();
    } catch (err) {
        listsState.textContent = `Fehler: ${err.message}`;
    }
}

function renderFilterOptions() {
    const selected = filterSource.value;
    filterSource.innerHTML = '<option value="">all sources</option>';
    state.feeds.forEach(feed => {
        const option = document.createElement('option');
        option.value = feed.id;
        option.textContent = feed.name;
        filterSource.appendChild(option);
    });
    filterSource.value = selected;
}

function renderListFilterOptions() {
    const selected = filterList.value;
    filterList.innerHTML = '<option value="">all lists</option>';
    state.lists.forEach(list => {
        const option = document.createElement('option');
        option.value = list.id;
        option.textContent = list.name;
        filterList.appendChild(option);
    });
    filterList.value = selected;
}

async function loadFeeds() {
    feedsState.style.display = 'block';
    feedsState.textContent = 'Lädt…';
    try {
        state.feeds = await apiFetch('/api/feeds');
        renderFeeds();
        renderFilterOptions();
    } catch (err) {
        feedsState.textContent = `Fehler: ${err.message}`;
    }
}

function renderArticles(articles) {
    articlesList.innerHTML = '';

    if (articles.length === 0) {
        articlesState.textContent = 'Nothing found, try other search input or delete all';
        articlesState.style.display = 'block';
        return;
    }

    articlesState.style.display = 'none';
    const template = document.getElementById('article-card-template');

    articles.forEach(article => {
        const node = template.content.cloneNode(true);
        node.querySelector('.meta-date').textContent = formatDate(article.publishedAt);
        const sourceLogo = node.querySelector('.source-logo');
        const sourceName = node.querySelector('.source-name');

        if (article.sourceLogoDataUrl) {
            sourceLogo.src = article.sourceLogoDataUrl;
            sourceLogo.style.display = 'inline-block';
        } else {
            sourceLogo.style.display = 'none';
        }

        sourceName.textContent = article.sourceName || '—';
        node.querySelector('.title').textContent = article.title || 'Ohne Titel';
        node.querySelector('.teaser').textContent = article.teaser || '';

        const link = node.querySelector('.link');
        const addBtn = node.querySelector('.btn-add');

        if (article.url) {
            link.href = article.url;
        } else {
            link.remove();
        }

        if (addBtn) {
            addBtn.addEventListener('click', async () => {
                await openListModal(article.id);
            });
        }
        articlesList.appendChild(node);
    });
}

async function loadArticles() {
    const params = new URLSearchParams();
    const selectedList = filterList.value;
    const selected = filterSource.value;

    articlesState.style.display = 'none';
    articlesState.textContent = '';
    loadingRow.style.display = 'flex';

    loadingStartedAt = Date.now();

    if (selected) {
        params.set('feedId', selected);
    }
    if (selectedList) {
        params.set('listId', selectedList);
    }

    const query = searchInput.value.trim();

    if (query) {
        params.set('query', query);
    }

    try {
        const articles = await apiFetch(`/api/articles?${params.toString()}`);

        loadingRow.style.display = 'none';
        renderArticles(articles);
    } catch (err) {
        articlesState.textContent = `Fehler: ${err.message}`;
        articlesState.style.display = 'block';
    }
}

function resetForm() {
    state.editingId = null;
    feedName.value = '';
    feedWebsite.value = '';
    feedUrl.value = '';
    feedSubmit.textContent = 'Feed speichern';
    setStatus(feedFormStatus, '');
}

feedForm.addEventListener('submit', async event => {
    event.preventDefault();
    feedSubmit.disabled = true;
    setStatus(feedFormStatus, 'Speichern…');

    const payload = {
        name: feedName.value.trim(),
        websiteUrl: feedWebsite.value.trim(),
        feedUrl: feedUrl.value.trim(),
    };

    try {
        if (state.editingId) {
            await apiFetch(`/api/feeds/${state.editingId}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        } else {
            await apiFetch('/api/feeds', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
        }
        resetForm();
        await loadFeeds();
    } catch (err) {
        setStatus(feedFormStatus, `Fehler: ${err.message}`);
    } finally {
        feedSubmit.disabled = false;
    }
});

feedCancel.addEventListener('click', () => resetForm());

listForm.addEventListener('submit', async event => {
    event.preventDefault();
    listSubmit.disabled = true;
    setStatus(listFormStatus, 'Speichern…');

    const colorValue = listColor && listColor.value ? listColor.value.trim() : '#1d1d1f';
    const normalizedColor = colorValue.startsWith('#') ? colorValue : `#${colorValue}`;

    const payload = {
        name: listName.value.trim(),
        description: listDescription.value.trim(),
        color: normalizedColor || '#1d1d1f',
    };

    try {
        if (listEditingId) {
            await apiFetch(`/api/lists/${listEditingId}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        } else {
            await apiFetch('/api/lists', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
        }
        resetListForm();
        await loadLists();
    } catch (err) {
        setStatus(listFormStatus, `Fehler: ${err.message}`);
    } finally {
        listSubmit.disabled = false;
    }
});

listCancel.addEventListener('click', () => resetListForm());

modalClose.addEventListener('click', () => closeListModal());
modalCancel.addEventListener('click', () => closeListModal());
modalBackdrop.addEventListener('click', event => {
    if (event.target === modalBackdrop) {
        closeListModal();
    }
});
modalConfirm.addEventListener('click', async () => {
    const listId = modalListSelect.value;
    if (!listId || !pendingArticleId) {
        alert('Bitte eine Liste auswählen.');
        return;
    }
    try {
        await apiFetch(`/api/lists/${listId}/items`, {
            method: 'POST',
            body: JSON.stringify({ articleId: pendingArticleId }),
        });
        closeListModal();
    } catch (err) {
        alert(err.message);
    }
});

feedTest.addEventListener('click', async () => {
    const url = feedUrl.value.trim();
    if (!url) {
        setStatus(feedFormStatus, 'Bitte eine Feed-URL eingeben.');
        return;
    }

    feedTest.disabled = true;
    setStatus(feedFormStatus, 'Teste Feed…');
    try {
        const result = await apiFetch(`/api/feeds/test/url?url=${encodeURIComponent(url)}`);
        const titles = result.sampleTitles?.length ? `Beispiele: ${result.sampleTitles.join(' · ')}` : '';
        setStatus(feedFormStatus, `OK: ${result.itemCount} Items. ${titles}`);
    } catch (err) {
        setStatus(feedFormStatus, `Fehler: ${err.message}`);
    } finally {
        feedTest.disabled = false;
    }
});

filterSource.addEventListener('change', () => loadArticles());
filterList.addEventListener('change', () => loadArticles());
refreshArticlesBtn.addEventListener('click', () => loadArticles());
toggleLayoutBtn.addEventListener('click', () => {
    isListLayout = !isListLayout;
    localStorage.setItem(LAYOUT_KEY, isListLayout ? 'list' : 'cards');
    applyLayoutState();
});
runFetchBtn.addEventListener('click', async () => {
    runFetchBtn.disabled = true;
    runFetchBtn.textContent = 'Läuft…';
    try {
        await apiFetch('/api/fetch/run', { method: 'POST' });
        await loadArticles();
        await loadFetchStatus();
    } catch (err) {
        alert(`Fetch fehlgeschlagen: ${err.message}`);
    } finally {
        runFetchBtn.disabled = false;
        runFetchBtn.textContent = 'Fetch starten';
    }
});

searchInput.addEventListener('input', () => {
    if (searchTimer) {
        clearTimeout(searchTimer);
    }

    articlesList.innerHTML = '';
    articlesState.style.display = 'none';
    articlesState.textContent = '';
    loadingRow.style.display = 'flex';
    loadingStartedAt = Date.now();

    searchTimer = setTimeout(() => {
        loadArticles();
    }, 3000);
});

async function boot() {
    applyLayoutState();
    await loadFeeds();
    await loadLists();
    await loadArticles();
    await loadFetchStatus();
    setupSse();
}

boot();

function setupSse() {
    if (sse) {
        return;
    }
    sse = new EventSource('/api/events');
    sse.addEventListener('update', event => {
        try {
            const payload = JSON.parse(event.data || '{}');
            const eventName = payload.event || '';
            if (eventName === 'fetch.completed') {
                loadArticles();
                loadFetchStatus();
            }
            if (eventName === 'feeds.updated') {
                loadFeeds();
            }
            if (eventName === 'lists.updated') {
                loadLists();
            }
            if (eventName === 'lists.items.updated') {
                loadArticles();
            }
        } catch {
            return;
        }
    });
}
