import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const WIRED_RANKINGS_URL = 'https://www.wired.com/about/sitemap/';
const moduleSelector = '.recirc-most-popular-sparrow-tracking[data-most-popular-id]';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function rankingError(message, code = 'WIRED_RANKINGS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

export function parseWiredRankings(fragments, baseUrl = WIRED_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const module of document.querySelectorAll(moduleSelector)) {
            const heading = [...module.querySelectorAll('[data-testid="SectionTitle"]')]
                .find(element => element.closest(moduleSelector) === module);
            if (normalizeText(heading?.textContent) !== 'Most Popular') continue;
            const lists = [...module.children].filter(child => child.tagName === 'UL');
            if (lists.length !== 1) throw rankingError('WIRED Most Popular has no unambiguous article list');
            const items = [];
            const byUrl = new Map();
            const rows = [...lists[0].children].filter(child => child.tagName === 'LI').slice(0, 50);
            for (const [index, row] of rows.entries()) {
                if (row.matches('.ad, .advertisement, .hide-aside-ad, [data-ad], [data-advertisement]')
                    || row.querySelector('.ad, .ad__slot, [data-ad], [data-advertisement]')) continue;
                const links = [...row.querySelectorAll('a.summary-item__hed-link[href]')]
                    .filter(link => link.closest('li') === row && link.closest('ul') === lists[0]);
                if (!links.length) continue;
                if (links.length !== 1) throw rankingError('WIRED Most Popular item has ambiguous headline links');
                const anchor = links[0];
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { continue; }
                if (!canonicalUrl || hostname(canonicalUrl) !== 'wired.com'
                    || !/^\/(?:story|gallery|review)\/[^/]+\/$/.test(new URL(canonicalUrl).pathname)) continue;
                const title = normalizeText(anchor.querySelector('[data-testid="SummaryItemHed"]')?.textContent).slice(0, 1_000);
                if (!title) continue;
                const previous = byUrl.get(canonicalUrl);
                if (previous) {
                    if (previous.title !== title) throw rankingError('WIRED Most Popular contains conflicting article titles', 'WIRED_RANKINGS_CONFLICT');
                    continue;
                }
                const item = { canonicalUrl, title, rank: index + 1 };
                byUrl.set(canonicalUrl, item);
                items.push(item);
            }
            if (!items.length) throw rankingError('WIRED Most Popular contains no usable articles');
            if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) {
                throw rankingError('WIRED contains conflicting Most Popular modules', 'WIRED_RANKINGS_CONFLICT');
            }
            ranking = items;
        }
    }
    if (!ranking?.length) throw rankingError('WIRED page does not contain its Most Popular selection');
    return { most_read: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('WIRED Most Popular is unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 'wired.com' || !/^\/about\/sitemap\/?$/.test(new URL(finalUrl).pathname)) {
        throw new Error('WIRED Most Popular has an invalid sitemap source URL');
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('WIRED Most Popular has no valid capture timestamp');
    }
    return {
        capturedAt: new Date(result.capturedAt).toISOString(),
        rankings: parseWiredRankings(result.data?.values, finalUrl),
    };
}

export async function fetchWiredRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: moduleSelector, all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(WIRED_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'WIRED_RANKINGS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return parseCapture(await extract(WIRED_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
