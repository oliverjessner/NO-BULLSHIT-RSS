import { api } from '../api/client.js';
import { isDesktop, invokeDesktop } from './desktop.js';
import { confirmDialog } from '../ui/design-system.js';
import { toast } from '../ui/toast.js';
import { enableWatchdogNotifications, watchdogNotificationStatus } from '../utils/watchdog.js';

const byId = id => document.getElementById(id);
let initialized = false;
let busy = false;
let unavailable = false;
let refreshId = 0;
let cachedPermission = '';

export async function refreshWatchdogNotifications({ permission: knownPermission, force = false, checkPermission = true } = {}) {
    if (busy && !force) return;
    const request = ++refreshId;
    const { enabled } = await api.watchdogNotifications();
    const button = byId('watchdog-notifications');
    let permission = knownPermission || (!checkPermission ? cachedPermission : '');
    if (isDesktop && !permission) permission = await invokeDesktop('watchdog_notification_permission', { request: false });
    if (request !== refreshId) return;
    cachedPermission = permission;
    unavailable = permission === 'unavailable';
    const status = watchdogNotificationStatus({ desktop: isDesktop, enabled, permission });
    button.dataset.enabled = String(enabled);
    button.textContent = status.label;
    button.disabled = status.disabled;
    byId('watchdog-notification-status').textContent = status.message;
}
async function toggleNotifications() {
    const trigger = byId('watchdog-notifications');
    if (!isDesktop || busy) return;
    busy = true; ++refreshId;
    trigger.disabled = true;
    try {
        if (trigger.dataset.enabled === 'true' && cachedPermission !== 'prompt') {
            await api.setWatchdogNotifications(false);
            await refreshWatchdogNotifications({ force: true });
            return;
        }
        if (!await confirmDialog({ title: 'Enable Watchdog notifications?', message: 'Allow macOS notifications for new matches? You will receive at most one summary per watchdog and three notifications per fetch. Historical matches and the first feed import stay silent. Watching continues while the app process is running, even with its window closed.', confirmLabel: 'Allow notifications', cancelLabel: 'Not now' })) return;
        const permission = await enableWatchdogNotifications(
            () => invokeDesktop('watchdog_notification_permission', { request: true }),
            enabled => api.setWatchdogNotifications(enabled),
        );
        await refreshWatchdogNotifications({ permission, force: true });
    } catch (error) {
        byId('watchdog-notification-status').textContent = error.message;
        throw error;
    } finally {
        busy = false;
        trigger.disabled = !isDesktop || (unavailable && trigger.dataset.enabled !== 'true');
    }
}

export function initWatchdogNotifications() {
    if (initialized) return;
    initialized = true;
    byId('watchdog-notifications').addEventListener('click', () => {
        void toggleNotifications().catch(error => toast.error(error.message));
    });
}
