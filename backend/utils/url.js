import { cleanUrl } from 'linkary';

// Keep functional query parameters (RSS selectors and article IDs), remove
// tracking parameters and fragments before persisting or comparing URLs.
export function cleanHttpUrl(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 2_048) return null;
    try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        return cleanUrl(url.href, { stripFragment: true }).cleanUrl;
    } catch {
        return null;
    }
}
