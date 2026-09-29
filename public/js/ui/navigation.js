import { dom } from './dom.js';
import { store } from '../state/store.js';
import { renderViewer } from '../services/article-viewer.js';

let activateView = async () => {};
let scrollScheduled = false;

export function isViewActive(name) { return store.ui.activeView === name; }

export async function navigate(name) {
    if (!dom.views[name]) return;
    store.ui.activeView = name;
    dom.navLinks.forEach(link => {
        const active = link.dataset.view === name;
        link.classList.toggle('is-active', active);
        link.classList.toggle('pf-is-active', active);
        link.setAttribute('aria-pressed', String(active));
    });
    Object.entries(dom.views).forEach(([key, view]) => view.classList.toggle('is-active', key === name));
    window.scrollTo(0, 0);
    updateStickyUi();
    renderViewer();
    await activateView(name);
}

function updateStickyUi() {
    const top = window.scrollY || document.documentElement.scrollTop || 0;
    dom.settings.tabsWrap?.classList.toggle('is-scrolled', store.ui.activeView === 'settings' && top > 2);
    dom.digest.header?.classList.toggle('is-scrolled', store.ui.activeView === 'digest' && top > 2);
    dom.feed.backToTop?.classList.toggle('hide', !(store.ui.activeView === 'main' && top > 480));
}

export function initNavigation(onActivate) {
    activateView = onActivate;
    dom.nav?.addEventListener('click', event => {
        const link = event.target.closest('.nav-link[data-view]');
        if (link) {
            void navigate(link.dataset.view).catch(error => {
                console.error(`Could not activate ${link.dataset.view} view:`, error);
            });
        }
    });
    window.addEventListener('scroll', () => {
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(() => { scrollScheduled = false; updateStickyUi(); });
    }, { passive: true });
    updateStickyUi();
}
