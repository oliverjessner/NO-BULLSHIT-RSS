import { toast as ojToast } from './design-system.js';

export function showToast(message, { type = 'info', actionLabel = '', onAction = null } = {}) {
    const dialog = document.querySelector('dialog[open]');
    const notification = ojToast(message, { type, duration: 6000, root: dialog || document });
    if (dialog) {
        dialog.addEventListener('close', notification.dismiss, { once: true });
        notification.element.addEventListener('oj:close', () => dialog.removeEventListener('close', notification.dismiss), { once: true });
    }
    if (actionLabel && typeof onAction === 'function') {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'oj-button oj-button-ghost oj-button-compact';
        action.textContent = actionLabel;
        action.addEventListener('click', async () => {
            action.disabled = true;
            try { await onAction(); notification.dismiss(); }
            catch (error) {
                action.disabled = false;
                showToast(`Undo failed: ${error.message}`, { type: 'error' });
            }
        });
        notification.element.insertBefore(action, notification.element.querySelector('.oj-toast-dismiss'));
    }
    return notification;
}

export const toast = Object.freeze({
    success: (message, options) => showToast(message, { ...options, type: 'success' }),
    error: (message, options) => showToast(message, { ...options, type: 'error' }),
    info: (message, options) => showToast(message, { ...options, type: 'info' }),
});
