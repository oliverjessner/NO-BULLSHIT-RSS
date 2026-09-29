import { dom } from '../ui/dom.js';
import { store } from '../state/store.js';
import { STORAGE_KEYS } from '../config.js';
import { setPressed } from '../utils/dom.js';

function render() {
    dom.feed.list.classList.toggle('is-list', store.ui.listLayout);
    setPressed(dom.feed.layoutOptions, option => option.dataset.layout === (store.ui.listLayout ? 'list' : 'cards'));
}

export function initLayout() {
    dom.feed.layout?.addEventListener('click', event => {
        const option = event.target.closest('[data-layout]');
        if (!option) return;
        store.ui.listLayout = option.dataset.layout === 'list';
        localStorage.setItem(STORAGE_KEYS.layout, store.ui.listLayout ? 'list' : 'cards');
        render();
    });
    render();
}
