import { extractFavicon } from 'fetchary';
import { all, run } from '../database/datenbank.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { publish } from './events.js';

const MAX_LOGO_BYTES = 200 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readBoundedResponse(url, options, maxBytes, deadline) {
    const signal = AbortSignal.any([options.signal, deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const response = await fetch(url, { ...options, signal });
    // Fetchary validates and follows each redirect; it also cancels this body.
    if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
        return { response, buffer: null };
    }
    const reader = response.body?.getReader();
    try {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Logo resource is too large');
        const chunks = [];
        let length = 0;
        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > maxBytes) throw new Error('Logo resource is too large');
                chunks.push(Buffer.from(value));
            }
        }
        const buffer = Buffer.concat(chunks, length);
        const copy = new Response(buffer, { status: response.status, headers: response.headers });
        // Fetchary resolves relative links against the final response URL.
        Object.defineProperty(copy, 'url', { value: response.url || String(url) });
        return { response: copy, buffer };
    } finally {
        await reader?.cancel().catch(() => {});
    }
}

export async function fetchSiteLogo(websiteUrl, { allowPrivateNetwork = false } = {}) {
    try {
        const url = new URL(websiteUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
        const resources = new Map();
        let isPage = true;
        const result = await extractFavicon(url.href, {
            mode: 'http',
            timeout: REQUEST_TIMEOUT_MS,
            userAgent: 'no-bullshit-rss',
            allowPrivateNetwork,
            signal: deadline,
            fetch: async (resourceUrl, options) => {
                const page = isPage;
                const resource = await readBoundedResponse(resourceUrl, options, page ? MAX_PAGE_BYTES : MAX_LOGO_BYTES, deadline);
                if (resource.buffer !== null) {
                    // Keep the page budget until its final response, across redirects.
                    isPage = false;
                    if (!page) resources.set(resource.response.url, resource.buffer);
                }
                return resource.response;
            },
        });
        const buffer = resources.get(result.image.url);
        const mime = result.image.contentType;
        // Reuse the bytes Fetchary inspected, including icons served as octet-stream.
        return buffer?.length && mime?.startsWith('image/') ? { buffer, mime } : null;
    } catch (err) {
        logWarn('Logo fetch failed', { websiteUrl, error: err.message });
        return null;
    }
}

export async function refreshAllFeedLogos({ missingOnly = false, fetchLogo = fetchSiteLogo } = {}) {
    const sources = await all(`SELECT id, websiteUrl FROM sources
        WHERE EXISTS (SELECT 1 FROM feeds WHERE feeds.sourceId = sources.id)
        ${missingOnly ? 'AND (logo IS NULL OR logoMime IS NULL)' : ''}
        ORDER BY id`);
    let updated = 0;

    for (const source of sources) {
        const logo = await fetchLogo(source.websiteUrl);
        if (!logo) continue;
        const result = await run(`UPDATE sources SET logo = ?, logoMime = ?, updatedAt = datetime('now')
            WHERE id = ? AND websiteUrl = ? ${missingOnly ? 'AND (logo IS NULL OR logoMime IS NULL)' : ''}`, [
            logo.buffer,
            logo.mime,
            source.id,
            source.websiteUrl,
        ]);
        updated += result.changes;
    }

    if (updated) publish('feeds.updated', { logosUpdated: updated });
    logInfo('Logo refresh finished', { updated, total: sources.length });
    return { updated, total: sources.length };
}
