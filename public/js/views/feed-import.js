import { api } from '../api/client.js';
import { dom } from '../ui/dom.js';
import { closeDialog, openDialog } from '../ui/design-system.js';
import { toast } from '../ui/toast.js';
import { parseArticleImportText } from '../utils/import.js';

const MAX_IMPORT_FILE_BYTES = 512 * 1024;
let initialized = false;
let onImported = async () => {};

function setStatus(message) {
    dom.feedImport.status.textContent = message;
}

function reset() {
    dom.feedImport.urls.value = '';
    dom.feedImport.file.value = '';
    dom.feedImport.fileName.textContent = 'No file selected';
    setStatus('');
}

function close() {
    closeDialog(dom.feedImport.backdrop);
}

function open() {
    const menuTrigger = dom.feedImport.trigger.closest('[data-oj-dropdown]')?.querySelector('[data-oj-dropdown-trigger]');
    if (menuTrigger?.getAttribute('aria-expanded') === 'true') menuTrigger.click();
    openDialog(dom.feedImport.backdrop, { trigger: menuTrigger || dom.feedImport.trigger });
}

function summary(result, parsed) {
    const parts = [`${Number(result.imported || 0).toLocaleString('en-US')} imported`];
    const duplicates = Number(result.duplicates || 0) + parsed.duplicates;
    const invalid = Number(result.invalid || 0) + parsed.invalid;
    if (duplicates) parts.push(`${duplicates.toLocaleString('en-US')} already existed or duplicated`);
    if (invalid) parts.push(`${invalid.toLocaleString('en-US')} invalid`);
    if (result.failed) parts.push(`${Number(result.failed).toLocaleString('en-US')} failed`);
    return parts.join(' · ');
}

async function importUrls() {
    const parsed = parseArticleImportText(dom.feedImport.urls.value);
    if (parsed.overflow) { setStatus('Maximum 500 URLs per import. Split the list into smaller files.'); return; }
    if (!parsed.urls.length) { setStatus(parsed.invalid ? 'No valid HTTP(S) URLs found.' : 'Paste at least one article URL.'); return; }

    dom.feedImport.confirm.disabled = true;
    setStatus(`Importing ${parsed.urls.length.toLocaleString('en-US')} ${parsed.urls.length === 1 ? 'article' : 'articles'}…`);
    try {
        const result = await api.importArticles(parsed.urls);
        const message = summary(result, parsed);
        close();
        await onImported(result);
        toast.success(message);
    } catch (error) {
        setStatus(`Import failed: ${error.message}`);
    } finally {
        dom.feedImport.confirm.disabled = false;
    }
}

async function loadTextFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_FILE_BYTES) { setStatus('TXT file is too large. Maximum size: 512 KB.'); return; }
    if (!file.name.toLowerCase().endsWith('.txt') && file.type !== 'text/plain') { setStatus('Choose a plain .txt file.'); return; }
    try {
        const content = await file.text();
        dom.feedImport.urls.value = content;
        dom.feedImport.fileName.textContent = file.name;
        const parsed = parseArticleImportText(content);
        setStatus(`${parsed.urls.length.toLocaleString('en-US')} valid ${parsed.urls.length === 1 ? 'URL' : 'URLs'} loaded${parsed.invalid ? ` · ${parsed.invalid} invalid` : ''}.`);
    } catch (error) {
        setStatus(`Could not read file: ${error.message}`);
    }
}

export function initFeedImport(options = {}) {
    if (initialized) return;
    initialized = true;
    onImported = options.onImported || onImported;
    dom.feedImport.trigger.addEventListener('click', open);
    dom.feedImport.close.addEventListener('click', () => close());
    dom.feedImport.cancel.addEventListener('click', () => close());
    dom.feedImport.chooseFile.addEventListener('click', () => dom.feedImport.file.click());
    dom.feedImport.file.addEventListener('change', () => void loadTextFile(dom.feedImport.file.files?.[0]));
    dom.feedImport.confirm.addEventListener('click', () => void importUrls());
    dom.feedImport.backdrop.addEventListener('close', reset);
    dom.feedImport.backdrop.addEventListener('click', event => {
        if (event.target !== dom.feedImport.backdrop) return;
        const bounds = dom.feedImport.backdrop.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
}
