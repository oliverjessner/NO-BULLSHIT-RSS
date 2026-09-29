import { dom } from '../ui/dom.js';
import { store } from '../state/store.js';
import { STORAGE_KEYS } from '../config.js';
import { setPressed } from '../utils/dom.js';

function render() {
    document.documentElement.dataset.theme = store.ui.darkTheme ? 'dark' : 'light';
    dom.feed.list.classList.toggle('is-list', store.ui.listLayout);
    setPressed(dom.feed.layoutOptions, option => option.dataset.layout === (store.ui.listLayout ? 'list' : 'cards'));
    if (dom.settings.themeToggle) {
        dom.settings.themeToggle.checked = store.ui.darkTheme;
        const label = document.getElementById('theme-mode-label');
        if (label) label.textContent = store.ui.darkTheme ? 'Dark' : 'Light';
    }
}

export function initTheme() {
    dom.feed.layout?.addEventListener('click', event => {
        const option = event.target.closest('[data-layout]');
        if (!option) return;
        store.ui.listLayout = option.dataset.layout === 'list';
        localStorage.setItem(STORAGE_KEYS.layout, store.ui.listLayout ? 'list' : 'cards');
        render();
    });
    dom.settings.themeToggle?.addEventListener('change', event => {
        store.ui.darkTheme = Boolean(event.currentTarget.checked);
        localStorage.setItem(STORAGE_KEYS.theme, store.ui.darkTheme ? 'dark' : 'light');
        render();
    });
    render();
}
