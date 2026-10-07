// OJ owns opening, focus, keyboard navigation and dismissal. The app owns exports.
export function bindExportMenu({ root, trigger, popover, onSelect }) {
    let loading = false;
    const label = trigger?.querySelector('[data-export-label]');
    const formatButtons = [...(popover?.querySelectorAll('[data-export-format]') || [])];

    function close() {
        if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click();
    }

    function setLoading(next) {
        loading = Boolean(next);
        if (loading) close();
        trigger.disabled = loading;
        trigger.setAttribute('aria-disabled', String(loading));
        formatButtons.forEach(button => { button.disabled = loading; });
        if (label) label.textContent = loading ? 'Exporting…' : 'Export';
    }

    root?.addEventListener('oj:select', async event => {
        const option = event.detail.item;
        if (!option?.hasAttribute('data-export-format') || loading) return;
        event.preventDefault();
        close();
        setLoading(true);
        try { await onSelect(option.dataset.exportFormat); }
        finally { setLoading(false); }
    });

    return Object.freeze({ close, setLoading });
}
