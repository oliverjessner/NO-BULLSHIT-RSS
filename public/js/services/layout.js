import { dom } from '../ui/dom.js';
import { store } from '../state/store.js';
import { STORAGE_KEYS } from '../config.js';

function render() {
    dom.feed.list.classList.toggle('is-list', store.ui.listLayout);
    dom.feed.layoutSlider.value = store.ui.listLayout ? '0' : '1';
    dom.feed.layoutSlider.setAttribute('aria-valuetext', store.ui.listLayout ? 'Compact' : 'Cards');
    dom.feed.layoutLabels.forEach(label => {
        label.classList.toggle('is-active', label.dataset.layout === (store.ui.listLayout ? 'list' : 'cards'));
    });
}

export function initLayout() {
    dom.feed.layoutSlider.addEventListener('input', () => {
        store.ui.listLayout = dom.feed.layoutSlider.value === '0';
        localStorage.setItem(STORAGE_KEYS.layout, store.ui.listLayout ? 'list' : 'cards');
        render();
    });
    render();
}
