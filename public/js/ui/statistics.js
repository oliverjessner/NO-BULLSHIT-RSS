import { api } from '../api/client.js';
import { dom } from './dom.js';
import { closeDialog, openDialog } from './design-system.js';

const formatCount = value => Number(value).toLocaleString('en-US');
let initialized = false;
let requestController = null;

function renderRanking(container, entries, emptyMessage) {
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
        const item = document.createElement('li'); item.className = 'statistics-row';
        const name = document.createElement('span'); name.className = 'statistics-name'; name.textContent = entry.name; name.title = entry.name;
        const count = document.createElement('span'); count.className = 'statistics-count oj-mono'; count.textContent = formatCount(entry.count);
        item.append(name, count); fragment.appendChild(item);
    }
    if (!entries.length) {
        const empty = document.createElement('li'); empty.className = 'statistics-empty oj-muted'; empty.textContent = emptyMessage;
        fragment.appendChild(empty);
    }
    container.replaceChildren(fragment);
}

async function loadStatistics() {
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    dom.statistics.dialog.setAttribute('aria-busy', 'true');
    dom.statistics.status.textContent = 'Loading statistics…';
    dom.statistics.content.hidden = true;
    dom.statistics.refresh.disabled = true;
    try {
        const result = await api.statistics(controller.signal);
        if (controller !== requestController || !dom.statistics.dialog.open) return;
        dom.statistics.total.textContent = formatCount(result.totalArticles);
        dom.statistics.bullshit.textContent = formatCount(result.bullshitArticles);
        renderRanking(dom.statistics.feeds, result.topFeeds, 'No feed articles yet.');
        renderRanking(dom.statistics.topics, result.topTopics, 'No topics assigned yet.');
        dom.statistics.content.hidden = false;
        dom.statistics.status.textContent = '';
    } catch (error) {
        if (controller.signal.aborted || controller !== requestController) return;
        dom.statistics.status.textContent = `Could not load statistics: ${error.message}`;
    } finally {
        if (controller === requestController) {
            requestController = null;
            dom.statistics.dialog.setAttribute('aria-busy', 'false');
            dom.statistics.refresh.disabled = false;
        }
    }
}

export function initStatistics() {
    if (initialized) return;
    initialized = true;
    const close = () => closeDialog(dom.statistics.dialog);
    dom.statistics.trigger.addEventListener('click', () => {
        openDialog(dom.statistics.dialog, { trigger: dom.statistics.trigger });
        void loadStatistics();
    });
    dom.statistics.refresh.addEventListener('click', () => void loadStatistics());
    dom.statistics.close.addEventListener('click', close);
    dom.statistics.done.addEventListener('click', close);
    dom.statistics.dialog.addEventListener('close', () => {
        requestController?.abort();
        requestController = null;
        dom.statistics.dialog.setAttribute('aria-busy', 'false');
        dom.statistics.refresh.disabled = false;
    });
    dom.statistics.dialog.addEventListener('click', event => {
        if (event.target !== dom.statistics.dialog) return;
        const bounds = dom.statistics.dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
}
