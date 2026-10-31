export function parseWatchdogTerms(value) {
    return [...new Set(String(value || '').split(/[,\n]/u).map(term => term.trim()).filter(Boolean))];
}

export function watchdogNotificationStatus({ desktop, enabled, permission }) {
    const needsAuthorization = enabled && permission === 'prompt';
    return {
        label: needsAuthorization ? 'Allow notifications' : enabled ? 'Disable notifications' : 'Enable notifications',
        disabled: !desktop || (!enabled && permission === 'unavailable'),
        needsAuthorization,
        message: !desktop ? 'Native notifications are available in the macOS app.'
            : permission === 'unavailable' ? 'Notifications require the bundled macOS app. Open NO BULLSHIT RSS.app to enable them.'
            : enabled && permission === 'denied' ? 'Blocked by macOS. Allow notifications for NO BULLSHIT RSS in System Settings.'
            : needsAuthorization ? 'macOS permission is missing. Click Allow notifications to authorize banners.'
            : enabled ? 'Notifications enabled. The app keeps watching when its window is closed.'
            : 'Notifications are off. Matches are still saved locally.',
    };
}

export async function enableWatchdogNotifications(requestPermission, savePreference) {
    const permission = await requestPermission();
    if (permission !== 'granted') {
        throw new Error(permission === 'denied'
            ? 'Notifications denied. You can allow them in macOS System Settings.'
            : permission === 'prompt' ? 'macOS notification permission was not granted. Try enabling notifications again.'
            : 'macOS notification permissions are unavailable. Use the bundled macOS app to enable notifications.');
    }
    await savePreference(true);
    return permission;
}
