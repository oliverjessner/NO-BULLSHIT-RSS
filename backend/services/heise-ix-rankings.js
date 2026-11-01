import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const HEISE_IX_RANKINGS_URL = 'https://www.heise.de/ix/';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function rankingError(message, code = 'HEISE_IX_TOP_NEWS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

// Top-News is the publisher's editorial order, not a readership measurement.
export function parseHeiseIxRankings(fragments, baseUrl = HEISE_IX_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const module of document.querySelectorAll('[data-component="TeasersModule"]')) {
            const header = [...module.children].find(child => child.getAttribute('data-component') === 'ModuleHeader');
            if (normalizeText(header?.querySelector('h2')?.textContent) !== 'Top-News') continue;
            const lists = [...module.children].filter(child => child.getAttribute('data-component') === 'TeaserList');
            if (lists.length !== 1) throw rankingError('Heise iX Top-News has no unambiguous article list');
            const items = [];
            const byUrl = new Map();
            const articles = [...lists[0].querySelectorAll('article[data-component="TeaserContainer"]')]
                .filter(article => article.closest('[data-component="TeaserList"]') === lists[0]
                    && article.closest('[data-component="TeasersModule"]') === module).slice(0, 50);
            for (const article of articles) {
                if (article.closest('.ad, .advertisement, [data-ad], [data-advertisement], iframe')) continue;
                const anchor = [...article.querySelectorAll('a[data-component="TeaserLinkContainer"][href]')]
                    .find(link => link.closest('article[data-component="TeaserContainer"]') === article);
                if (!anchor) continue;
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { continue; }
                if (!canonicalUrl || hostname(canonicalUrl) !== 'heise.de'
                    || !/^\/news\/[^/]+-\d+\.html$/.test(new URL(canonicalUrl).pathname)) continue;
                const headline = anchor.querySelector('[data-component="TeaserHeadline"]');
                const title = normalizeText((headline?.querySelector('[data-upscore-title]') || headline
                    || anchor.querySelector('[data-upscore-title]'))?.textContent).slice(0, 1_000);
                if (!title) continue;
                const previous = byUrl.get(canonicalUrl);
                if (previous) {
                    if (previous.title !== title) throw rankingError('Heise iX Top-News contains conflicting article titles', 'HEISE_IX_TOP_NEWS_CONFLICT');
                    continue;
                }
                const item = { canonicalUrl, title, rank: items.length + 1 };
                byUrl.set(canonicalUrl, item);
                items.push(item);
            }
            if (!items.length) throw rankingError('Heise iX Top-News contains no usable articles');
            if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) {
                throw rankingError('Heise iX contains conflicting Top-News modules', 'HEISE_IX_TOP_NEWS_CONFLICT');
            }
            ranking = items;
        }
    }
    if (!ranking?.length) throw rankingError('Heise iX page does not contain its Top-News module');
    return { top_news: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('Heise iX Top-News is unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 'heise.de' || !/^\/ix\/?$/.test(new URL(finalUrl).pathname)) {
        throw new Error('Heise iX Top-News has an invalid source URL');
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('Heise iX Top-News has no valid capture timestamp');
    }
    return {
        capturedAt: new Date(result.capturedAt).toISOString(),
        rankings: parseHeiseIxRankings(result.data?.values, finalUrl),
    };
}

export async function fetchHeiseIxRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '[data-component="TeasersModule"]', all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(HEISE_IX_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'HEISE_IX_TOP_NEWS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return parseCapture(await extract(HEISE_IX_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
