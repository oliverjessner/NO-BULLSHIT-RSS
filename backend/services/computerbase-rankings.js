import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const COMPUTERBASE_RANKINGS_URL = 'https://www.computerbase.de/';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function rankingError(message, code = 'COMPUTERBASE_RANKINGS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

export function parseComputerBaseRankings(fragments, baseUrl = COMPUTERBASE_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const box of document.querySelectorAll('.box')) {
            const heading = [...box.children].find(child => /^H[1-6]$/.test(child.tagName));
            if (normalizeText(heading?.textContent) !== 'Meistgelesene News') continue;
            const list = [...box.children].find(child => child.matches('ol.charts'));
            if (!list) throw rankingError('ComputerBase most-read news list is missing');
            const items = [];
            const byUrl = new Map();
            const byRank = new Map();
            const rows = [...list.children].filter(child => child.tagName === 'LI').slice(0, 50);
            for (const row of rows) {
                const anchor = [...row.children].find(child => child.matches('a.charts__link--compact[href]'));
                if (!anchor || row.matches('.ad, .advertisement, [data-ad], [data-advertisement]')
                    || anchor.matches('.ad, .advertisement, [data-ad], [data-advertisement]')) continue;
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { continue; }
                if (!canonicalUrl || hostname(canonicalUrl) !== 'computerbase.de'
                    || !/^\/news\/(?:[^/]+\/)*[^/]+\.\d+\/$/.test(new URL(canonicalUrl).pathname)) continue;
                const rankText = normalizeText(anchor.querySelector('.charts__rank')?.textContent);
                const rank = /^[1-9]\d*$/.test(rankText) ? Number(rankText) : NaN;
                const context = normalizeText(anchor.querySelector('.charts__context')?.textContent);
                const headline = normalizeText(anchor.querySelector('.charts__title')?.textContent);
                if (!Number.isSafeInteger(rank) || !headline || /^(?:Anzeige|Werbung|Advertisement)$/i.test(context)) continue;
                const item = { canonicalUrl, title: (context ? `${context}: ${headline}` : headline).slice(0, 1_000), rank };
                const previous = byUrl.get(canonicalUrl) || byRank.get(rank);
                if (previous) {
                    if (JSON.stringify(previous) !== JSON.stringify(item)) throw rankingError('ComputerBase most-read news contains conflicting ranks or URLs', 'COMPUTERBASE_RANKINGS_CONFLICT');
                    continue;
                }
                byUrl.set(canonicalUrl, item); byRank.set(rank, item);
                items.push(item);
            }
            if (!items.length) throw rankingError('ComputerBase most-read news contains no usable articles');
            items.sort((left, right) => left.rank - right.rank);
            if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) throw rankingError('ComputerBase contains conflicting most-read news blocks', 'COMPUTERBASE_RANKINGS_CONFLICT');
            ranking = items;
        }
    }
    if (!ranking?.length) throw rankingError('ComputerBase page does not contain its most-read news ranking');
    return { most_read: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('ComputerBase rankings are unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 'computerbase.de') throw new Error('ComputerBase rankings have an invalid source URL');
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('ComputerBase rankings have no valid capture timestamp');
    }
    return {
        capturedAt: new Date(result.capturedAt).toISOString(),
        rankings: parseComputerBaseRankings(result.data?.values, finalUrl),
    };
}

export async function fetchComputerBaseRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '.box--sidebar', all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(COMPUTERBASE_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'COMPUTERBASE_RANKINGS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return parseCapture(await extract(COMPUTERBASE_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
