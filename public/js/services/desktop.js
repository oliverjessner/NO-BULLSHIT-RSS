const native = globalThis.__TAURI__?.core;
export const isDesktop = Boolean(native);

export function invokeDesktop(command, args = {}) {
    return native ? native.invoke(command, args) : Promise.resolve();
}

export function openBrowser(url) {
    if (isDesktop) return invokeDesktop('open_external', { url });
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
}

export function initDesktop() {
    if (!isDesktop) return;
    // Some article/digest actions use window.open directly.
    window.open = url => {
        void openBrowser(String(url)).catch(console.error);
        return null;
    };
    document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]');
        if (!link || event.defaultPrevented || !/^https?:/i.test(link.href)) return;
        event.preventDefault();
        void openBrowser(link.href).catch(console.error);
    });
    document.addEventListener('contextmenu', event => {
        if (event.target.closest?.('input, textarea, [contenteditable="true"]')) return;
        const text = window.getSelection()?.toString().trim();
        if (!text) return;
        event.preventDefault();
        void invokeDesktop('selection_menu', { text }).catch(console.error);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'F12') {
            event.preventDefault();
            void invokeDesktop('toggle_devtools').catch(console.error);
        }
    });
}

// Serialize requests so an older navigation/resize cannot reopen a hidden viewer.
export function createViewerSync(send) {
    let pending;
    let running = false;
    return async payload => {
        pending = payload;
        if (running) return;
        running = true;
        try {
            while (pending) {
                const current = pending;
                pending = undefined;
                try { await send(current); } catch (error) { console.error('Article viewer failed:', error); }
            }
        } finally { running = false; }
    };
}
