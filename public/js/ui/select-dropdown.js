// Native selects retain form/data state; OJ owns the visible menu and keyboard behavior.
const dropdowns = new WeakMap();

export function syncSelectDropdown(select) {
    dropdowns.get(select)?.sync();
}

export function setSelectValue(select, value) {
    select.value = value;
    syncSelectDropdown(select);
}

export function focusSelectDropdown(select) {
    (dropdowns.get(select)?.trigger || select).focus({ preventScroll: true });
}

function enhance(select) {
    const document = select.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.className = 'select select-dropdown oj-dropdown';
    wrapper.setAttribute('data-oj-dropdown', '');
    const trigger = document.createElement('button');
    trigger.id = `${select.id}-trigger`;
    trigger.type = 'button';
    trigger.className = 'select-dropdown-trigger oj-button oj-button-secondary';
    trigger.setAttribute('data-oj-dropdown-trigger', '');
    const valueLabel = document.createElement('span');
    valueLabel.id = `${select.id}-value`;
    valueLabel.className = 'select-dropdown-value';
    const arrow = document.createElement('i');
    arrow.className = 'fa-solid fa-chevron-down';
    arrow.setAttribute('aria-hidden', 'true');
    trigger.append(valueLabel, arrow);
    const menu = document.createElement('div');
    menu.id = `${select.id}-menu`;
    menu.className = 'select-dropdown-menu oj-menu';
    menu.setAttribute('data-oj-dropdown-menu', '');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const labels = [...select.labels];
    const labelState = labels.map(label => ({ label, id: label.getAttribute('id'), target: label.getAttribute('for') }));
    labels.forEach((label, index) => {
        label.id ||= `${select.id}-label-${index}`;
        label.htmlFor = trigger.id;
    });
    const name = select.getAttribute('aria-label') || labels.map(label => label.textContent.trim()).join(' ') || 'Choose option';
    menu.setAttribute('aria-label', name);
    if (labels.length) trigger.setAttribute('aria-labelledby', [...labels.map(label => label.id), valueLabel.id].join(' '));
    const hidden = select.hidden;
    const autofocus = select.autofocus;
    trigger.autofocus = autofocus;
    select.autofocus = false;
    select.hidden = true;
    select.before(wrapper);
    wrapper.append(select, trigger, menu);

    let optionsKey;
    function close() {
        if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
    }
    function sync() {
        const options = [...select.options];
        const nextKey = JSON.stringify(options.map(option => [option.value, option.textContent, option.disabled || option.parentElement.disabled, option.hidden]));
        let focusAfterSync;
        if (optionsKey !== nextKey) {
            const focused = [...menu.children].find(item => item === document.activeElement);
            const fragment = document.createDocumentFragment();
            for (const option of options) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'oj-menu-item';
                item.setAttribute('role', 'menuitemradio');
                item.tabIndex = -1;
                item.dataset.ojValue = option.value;
                item.disabled = option.disabled || Boolean(option.parentElement.disabled);
                item.hidden = option.hidden;
                const check = document.createElement('i');
                check.className = 'select-dropdown-check fa-solid fa-check';
                check.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.textContent = option.textContent;
                item.append(check, label);
                fragment.appendChild(item);
            }
            menu.replaceChildren(fragment);
            optionsKey = nextKey;
            if (focused) {
                const enabled = [...menu.children].filter(item => !item.disabled && !item.hidden);
                focusAfterSync = enabled.find(item => item.dataset.ojValue === focused.dataset.ojValue) || enabled[0] || trigger;
            }
        }
        valueLabel.textContent = select.selectedOptions[0]?.textContent || 'Choose option';
        if (!labels.length) trigger.setAttribute('aria-label', `${name}: ${valueLabel.textContent}`);
        [...menu.children].forEach((item, index) => item.setAttribute('aria-checked', String(index === select.selectedIndex)));
        if (select.disabled) close();
        trigger.disabled = select.disabled;
        focusAfterSync?.focus({ preventScroll: true });
    }
    function onSelect(event) {
        if (event.target !== wrapper || event.detail.item.disabled) return;
        const previous = select.value;
        setSelectValue(select, event.detail.value);
        if (select.value !== previous) select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function onReset() {
        // The reset event precedes the browser's restoration of default values.
        queueMicrotask(sync);
    }
    function prepareMenu() {
        sync();
        menu.style.minWidth = `${Math.min(Math.max(192, trigger.getBoundingClientRect().width), document.defaultView.innerWidth - 16)}px`;
    }
    function keepFocusedItemVisible(event) {
        const item = event.target.closest('[role="menuitemradio"]');
        if (!item || item.parentElement !== menu) return;
        // OJ preserves page scroll on focus; scroll only the option list itself.
        const bounds = menu.getBoundingClientRect();
        const option = item.getBoundingClientRect();
        const top = bounds.top + menu.clientTop;
        const bottom = top + menu.clientHeight;
        if (option.top < top) menu.scrollTop -= top - option.top;
        else if (option.bottom > bottom) menu.scrollTop += option.bottom - bottom;
    }
    const form = select.form;
    const dialog = select.closest('dialog');
    wrapper.addEventListener('oj:select', onSelect);
    menu.addEventListener('focusin', keepFocusedItemVisible);
    trigger.addEventListener('click', prepareMenu);
    trigger.addEventListener('keydown', prepareMenu);
    select.addEventListener('change', sync);
    form?.addEventListener('reset', onReset);
    dialog?.addEventListener('close', close);
    dropdowns.set(select, { sync, trigger });
    sync();
    return () => {
        wrapper.removeEventListener('oj:select', onSelect);
        menu.removeEventListener('focusin', keepFocusedItemVisible);
        trigger.removeEventListener('click', prepareMenu);
        trigger.removeEventListener('keydown', prepareMenu);
        select.removeEventListener('change', sync);
        form?.removeEventListener('reset', onReset);
        dialog?.removeEventListener('close', close);
        dropdowns.delete(select);
        wrapper.before(select);
        wrapper.remove();
        select.hidden = hidden;
        select.autofocus = autofocus;
        for (const { label, id, target } of labelState) {
            if (id === null) label.removeAttribute('id'); else label.id = id;
            if (target === null) label.removeAttribute('for'); else label.setAttribute('for', target);
        }
    };
}

export function initSelectDropdowns(root = document) {
    const cleanups = [...root.querySelectorAll('select[data-oj-select-dropdown]')]
        .filter(select => !dropdowns.has(select)).map(enhance);
    return () => cleanups.splice(0).reverse().forEach(cleanup => cleanup());
}
