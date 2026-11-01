import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { RANKING_KEYS } from './ranking-media.js';
import { fetchWinFuturePopularHtml } from './winfuture-popular.js';

export const WINFUTURE_RANKINGS_URL = 'https://winfuture.de/';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const host = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function missingRankings(message = 'WinFuture page does not contain both article rankings') {
    const error = new Error(message);
    error.code = 'WINFUTURE_RANKINGS_MISSING';
    error.phase = 'parse';
    return error;
}

export function parseWinFutureRankings(fragments, baseUrl = WINFUTURE_RANKINGS_URL, { requireBoth = true } = {}) {
    const rankings = {};
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const block of document.querySelectorAll('.rightBx')) {
            const heading = normalizeText(block.querySelector('.rightBxHead')?.textContent);
            const rankingKey = heading === 'Beliebte Nachrichten' ? 'most_read'
                : heading === 'Meist kommentierte Nachrichten' ? 'most_commented' : null;
            if (!rankingKey) continue;
            // The publisher's popular sidebar has 24h, 48h and 7d tabs.
            // Capture the explicit 24h list, never an empty/hidden later tab.
            const list = rankingKey === 'most_read'
                ? block.querySelector('.news_beliebteste_24 > ul')
                : block.querySelector('ul.right_news');
            if (!list) {
                if (requireBoth) throw missingRankings(`WinFuture ${rankingKey} list is missing`);
                continue;
            }
            const items = [];
            const urls = new Set();
            const ranks = new Set();
            [...list.children].filter(child => child.tagName === 'LI').slice(0, 50).forEach((row, index) => {
                const anchors = [...row.querySelectorAll('a[href]')];
                // The commented list also has an image link to the same item.
                const anchor = anchors.find(link => normalizeText(link.textContent));
                if (!anchor) return;
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { return; }
                if (!canonicalUrl || host(canonicalUrl) !== 'winfuture.de' || !/^\/news,\d+\.html$/.test(new URL(canonicalUrl).pathname)) return;
                const title = normalizeText(anchor.getAttribute('title') || anchor.textContent).slice(0, 1_000);
                const displayedRank = normalizeText(row.querySelector('dfn')?.textContent);
                const rank = rankingKey === 'most_read' && displayedRank ? Number(displayedRank) : index + 1;
                if (!title || !Number.isSafeInteger(rank) || rank <= 0 || urls.has(canonicalUrl) || ranks.has(rank)) return;
                urls.add(canonicalUrl); ranks.add(rank);
                items.push({ canonicalUrl, title, rank });
            });
            if (!items.length) {
                if (requireBoth) throw missingRankings(`WinFuture ${rankingKey} contains no usable articles`);
                continue;
            }
            if (rankings[rankingKey] && JSON.stringify(rankings[rankingKey]) !== JSON.stringify(items)) throw new Error(`WinFuture ${rankingKey} contains conflicting ranking blocks`);
            rankings[rankingKey] = items;
        }
    }
    if (requireBoth && RANKING_KEYS.some(key => !rankings[key]?.length)) throw missingRankings();
    return rankings;
}

export function parseWinFuturePopularHtml(html) {
    const { document } = parseHTML(html);
    const items = [];
    const urls = new Set();
    [...document.querySelectorAll('h2 a[href]')].slice(0, 50).forEach((anchor, index) => {
        let canonicalUrl;
        try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), WINFUTURE_RANKINGS_URL).href); }
        catch { return; }
        if (!canonicalUrl || host(canonicalUrl) !== 'winfuture.de' || !/^\/news,\d+\.html$/.test(new URL(canonicalUrl).pathname) || urls.has(canonicalUrl)) return;
        const title = normalizeText(anchor.getAttribute('title') || anchor.textContent).slice(0, 1_000);
        if (!title) return;
        urls.add(canonicalUrl);
        items.push({ canonicalUrl, title, rank: index + 1 });
    });
    if (!items.length) throw missingRankings('WinFuture popular tab contains no usable articles');
    return items;
}

function parseCapture(result) {
    if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300) throw new Error('WinFuture rankings are unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl || WINFUTURE_RANKINGS_URL);
    if (!finalUrl || host(finalUrl) !== 'winfuture.de') throw new Error('WinFuture rankings redirected to another site');
    const rankings = parseWinFutureRankings(result.data?.values, finalUrl, { requireBoth: false });
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('WinFuture rankings have no valid capture timestamp');
    }
    return { capturedAt: new Date(result.capturedAt).toISOString(), rankings };
}

export async function fetchWinFutureRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
    fetchPopular = extract === extractSelector ? fetchWinFuturePopularHtml : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '.rightBx.right_greenBx, .rightBx.right_orangeBx', all: true, format: 'html',
        consent: 'accept', timeout: 12_000, signal, cacheTtlMs: 60_000,
        maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let popularRequest;
    async function complete(snapshot) {
        if (RANKING_KEYS.every(key => snapshot.rankings[key]?.length)) return snapshot;
        if (!snapshot.rankings.most_read?.length && snapshot.rankings.most_commented?.length && fetchPopular) {
            popularRequest ||= fetchPopular({ signal });
            const popular = await popularRequest;
            if (typeof popular.capturedAt !== 'string' || !Number.isFinite(Date.parse(popular.capturedAt))) throw new Error('WinFuture popular tab has no valid capture timestamp');
            return {
                capturedAt: new Date(Math.max(Date.parse(snapshot.capturedAt), Date.parse(popular.capturedAt))).toISOString(),
                rankings: { ...snapshot.rankings, most_read: parseWinFuturePopularHtml(popular.html) },
            };
        }
        throw missingRankings();
    }
    let httpFailure;
    try { return await complete(parseCapture(await extract(WINFUTURE_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 }))); }
    catch (error) {
        if (!['WINFUTURE_RANKINGS_MISSING', 'WINFUTURE_POPULAR_UNAVAILABLE'].includes(error.code)) throw error;
        httpFailure = error;
    }
    try { signal.throwIfAborted(); configureBrowser?.(); }
    catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return complete(parseCapture(await extract(WINFUTURE_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 })));
}
