import { api } from '../api/client.js';
import { dom } from './dom.js';
import { store } from '../state/store.js';
import { clear, option } from '../utils/dom.js';
import { normalizeIds } from '../utils/data.js';
import { toast } from './toast.js';
import { closeDialog, openDialog } from './design-system.js';
import { focusSelectDropdown, syncSelectDropdown } from './select-dropdown.js';

let pendingIds = [];
let openRequest = 0;
let onSaved = async () => {};

function close() {
    closeDialog(dom.modal.backdrop, 'cancel');
}

async function renderExisting(lists) {
    clear(dom.modal.existing);
    if (!lists.length) { dom.modal.existing.textContent = '—'; return; }
    const fragment = document.createDocumentFragment();
    for (const list of lists) {
        const chip = document.createElement('span'); chip.className = 'modal-chip oj-tag';
        const dot = document.createElement('span'); dot.className = 'modal-chip-dot'; dot.style.background = list.color || '#1d1d1f';
        const label = document.createElement('span'); label.textContent = list.name;
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'modal-chip-remove oj-icon-button';
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-xmark'; icon.setAttribute('aria-hidden', 'true'); remove.appendChild(icon);
        remove.dataset.action = 'remove-list'; remove.dataset.listId = String(list.id); remove.setAttribute('aria-label', `Remove ${list.name} from selected articles`);
        chip.append(dot, label, remove); fragment.appendChild(chip);
    }
    dom.modal.existing.appendChild(fragment);
}

export async function openListModal(ids) {
    const normalized = normalizeIds(Array.isArray(ids) ? ids : [ids]);
    if (!normalized.length) return;
    const requestId = ++openRequest;
    const opener = document.activeElement;
    pendingIds = normalized;
    clear(dom.modal.select); option(dom.modal.select, '', 'Choose list');
    let existing = [];
    try {
        const payload = await api.articleLists(normalized);
        existing = normalized.length === 1 ? (payload?.listsByArticleId?.[String(normalized[0])] || []) : (payload?.commonLists || []);
    } catch { existing = []; }
    if (requestId !== openRequest) return;
    const existingIds = new Set(existing.map(list => String(list.id)));
    for (const list of store.reference.lists) {
        const node = option(dom.modal.select, list.id, existingIds.has(String(list.id)) ? `${list.name} (already)` : list.name);
        node.disabled = existingIds.has(String(list.id));
    }
    await renderExisting(existing);
    syncSelectDropdown(dom.modal.select);
    openDialog(dom.modal.backdrop, { trigger: opener });
    focusSelectDropdown(dom.modal.select);
}

export function initModal(options = {}) {
    onSaved = options.onSaved || onSaved;
    dom.modal.backdrop.addEventListener('close', () => { pendingIds = []; openRequest += 1; });
    dom.modal.close.addEventListener('click', close);
    dom.modal.cancel.addEventListener('click', close);
    dom.modal.backdrop.addEventListener('click', async event => {
        if (event.target === dom.modal.backdrop) {
            const rect = dom.modal.backdrop.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
            return;
        }
        const remove = event.target.closest('[data-action="remove-list"]');
        if (!remove) return;
        remove.disabled = true;
        try { await api.removeFromList(remove.dataset.listId, pendingIds); await openListModal(pendingIds); }
        catch (error) { remove.disabled = false; toast.error(`Remove from list failed: ${error.message}`); }
    });
    dom.modal.confirm.addEventListener('click', async () => {
        const listId = dom.modal.select.value;
        if (!listId || !pendingIds.length) { toast.info('Please choose a list.'); return; }
        dom.modal.confirm.disabled = true;
        try { await api.addToList(listId, pendingIds); close(); await onSaved(); toast.success('Saved to list'); }
        catch (error) { toast.error(error.message); }
        finally { dom.modal.confirm.disabled = false; }
    });
}
