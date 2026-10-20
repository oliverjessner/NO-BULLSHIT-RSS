export function parseWatchdogTerms(value) {
    return [...new Set(String(value || '').split(/[,\n]/u).map(term => term.trim()).filter(Boolean))];
}

export async function enableWatchdogNotifications(requestPermission, savePreference) {
    const permission = await requestPermission();
    if (permission !== 'granted') {
        throw new Error(permission === 'denied'
            ? 'Notifications denied. You can allow them in macOS System Settings.'
            : 'macOS notification permissions are unavailable. Use the bundled macOS app to enable notifications.');
    }
    await savePreference(true);
    return permission;
}
