import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const ARSTECHNICA_RANKINGS_URL = 'https://arstechnica.com/';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function rankingError(message, code = 'ARSTECHNICA_RANKINGS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

export function parseArsTechnicaRankings(fragments, baseUrl = ARSTECHNICA_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const module of document.querySelectorAll('.component-most-read')) {
            const header = [...module.querySelectorAll('header')].find(element => element.closest('.component-most-read') === module);
            if (normalizeText(header?.textContent) !== 'Most Read') continue;
            const lists = [...header.parentElement.children].filter(child => child.tagName === 'OL');
            if (lists.length !== 1) throw rankingError('Ars Technica Most Read has no unambiguous article list');
            const items = [];
            const byUrl = new Map();
            const byRank = new Map();
            const rows = [...lists[0].children].filter(child => child.tagName === 'LI').slice(0, 50);
            for (const row of rows) {
                if (row.matches('.ad, .advertisement, [data-ad], [data-advertisement]')) continue;
                const links = [...row.querySelectorAll('a.most-read-title[href]')]
                    .filter(link => link.closest('li') === row && link.closest('ol') === lists[0]);
                if (!links.length) continue;
                if (links.length !== 1) throw rankingError('Ars Technica Most Read item has ambiguous article links');
                const anchor = links[0];
                const rankElement = anchor.previousElementSibling;
                const rankText = rankElement?.tagName === 'SPAN' ? normalizeText(rankElement.textContent) : '';
                const rank = /^[1-9]\d*\.$/.test(rankText) ? Number(rankText.slice(0, -1)) : NaN;
                if (!Number.isSafeInteger(rank)) continue;
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { continue; }
                if (!canonicalUrl || hostname(canonicalUrl) !== 'arstechnica.com'
                    || !/^\/[^/]+\/\d{4}\/(?:0[1-9]|1[0-2])\/[^/]+\/$/.test(new URL(canonicalUrl).pathname)) continue;
                const title = normalizeText(anchor.textContent).slice(0, 1_000);
                if (!title) continue;
                const item = { canonicalUrl, title, rank };
                const previous = byUrl.get(canonicalUrl) || byRank.get(rank);
                if (previous) {
                    if (JSON.stringify(previous) !== JSON.stringify(item)) {
                        throw rankingError('Ars Technica Most Read contains conflicting ranks or articles', 'ARSTECHNICA_RANKINGS_CONFLICT');
                    }
                    continue;
                }
                byUrl.set(canonicalUrl, item);
                byRank.set(rank, item);
                items.push(item);
            }
            if (!items.length) throw rankingError('Ars Technica Most Read contains no usable articles');
            items.sort((left, right) => left.rank - right.rank);
            if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) {
                throw rankingError('Ars Technica contains conflicting Most Read modules', 'ARSTECHNICA_RANKINGS_CONFLICT');
            }
            ranking = items;
        }
    }
    if (!ranking?.length) throw rankingError('Ars Technica page does not contain its Most Read list');
    return { most_read: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('Ars Technica Most Read is unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 'arstechnica.com' || new URL(finalUrl).pathname !== '/') {
        throw new Error('Ars Technica Most Read has an invalid homepage source URL');
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('Ars Technica Most Read has no valid capture timestamp');
    }
    return {
        capturedAt: new Date(result.capturedAt).toISOString(),
        rankings: parseArsTechnicaRankings(result.data?.values, finalUrl),
    };
}

export async function fetchArsTechnicaRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '.component-most-read', all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(ARSTECHNICA_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'ARSTECHNICA_RANKINGS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return parseCapture(await extract(ARSTECHNICA_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
