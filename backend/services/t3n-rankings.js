import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const T3N_RANKINGS_URL = 'https://t3n.de/';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function rankingError(message, code = 'T3N_RANKINGS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

export function parseT3nRankings(fragments, baseUrl = T3N_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const target of document.querySelectorAll('#upscore-mostread-target')) {
            const lists = [...target.children].filter(child => child.matches('.most-read-items'));
            if (lists.length !== 1) throw rankingError('t3n most-read widget has no populated article list');
            const items = [];
            const byUrl = new Map();
            const rows = [...lists[0].children].filter(child => child.matches('.most-read-item-wrapper')).slice(0, 50);
            for (const [index, row] of rows.entries()) {
                if (row.matches('.ad, .advertisement, [data-ad], [data-advertisement]')) continue;
                const links = [...row.querySelectorAll('a.t-most-read__article[href]')]
                    .filter(link => link.closest('.most-read-item-wrapper') === row);
                if (links.length !== 1) throw rankingError('t3n most-read item has no unambiguous article link');
                const anchor = links[0];
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { continue; }
                if (!canonicalUrl || hostname(canonicalUrl) !== 't3n.de'
                    || !/^\/news\/[^/]+-\d+\/$/.test(new URL(canonicalUrl).pathname)) continue;
                const title = (normalizeText(anchor.querySelector('h4.most-read-title')?.textContent)
                    || normalizeText(anchor.getAttribute('title'))).slice(0, 1_000);
                if (!title || title === 'undefined' || /\$\{[^}]+\}/.test(title)) continue;
                const previous = byUrl.get(canonicalUrl);
                if (previous) {
                    if (previous.title !== title) throw rankingError('t3n most-read contains conflicting article titles', 'T3N_RANKINGS_CONFLICT');
                    continue;
                }
                // The publisher numbers these rows with a CSS counter, not text.
                const item = { canonicalUrl, title, rank: index + 1 };
                byUrl.set(canonicalUrl, item);
                items.push(item);
            }
            if (!items.length) throw rankingError('t3n most-read widget contains no usable articles');
            if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) {
                throw rankingError('t3n contains conflicting most-read widgets', 'T3N_RANKINGS_CONFLICT');
            }
            ranking = items;
        }
    }
    if (!ranking?.length) throw rankingError('t3n page does not contain a populated most-read widget');
    return { most_read: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('t3n most-read is unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 't3n.de' || new URL(finalUrl).pathname !== '/') {
        throw new Error('t3n most-read has an invalid source URL');
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('t3n most-read has no valid capture timestamp');
    }
    return {
        capturedAt: new Date(result.capturedAt).toISOString(),
        rankings: parseT3nRankings(result.data?.values, finalUrl),
    };
}

export async function fetchT3nRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '#upscore-mostread-target', all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(T3N_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'T3N_RANKINGS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    // t3n injects this widget through UpScore. Its page resources exceed
    // Fetchary's 12 MiB aggregate budget at the smaller HTTP response cap.
    return parseCapture(await extract(T3N_RANKINGS_URL, {
        ...options, mode: 'browser', timeout: 15_000, waitAfterLoad: 3_000, maxResponseBytes: 8 * 1024 * 1024,
    }));
}
