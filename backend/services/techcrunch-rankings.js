import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const TECHCRUNCH_RANKINGS_URL = 'https://techcrunch.com/';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

function rankingError(message, code = 'TECHCRUNCH_RANKINGS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

function isArticleUrl(value) {
    const url = new URL(value);
    if (hostname(value) !== 'techcrunch.com') return false;
    const match = url.pathname.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\/[^/]+\/$/);
    if (!match) return false;
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() === Number(match[1])
        && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}

// This is the homepage's editorial Top Headlines selection, not Most Popular.
export function parseTechCrunchRankings(fragments, baseUrl = TECHCRUNCH_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const section of document.querySelectorAll('.hero-package-2__list')) {
            const heading = [...section.children].find(child => child.matches('p.hero-package-2__heading'));
            if (normalizeText(heading?.querySelector('strong')?.textContent) !== 'Top Headlines') continue;
            const cards = [...section.children].filter(child => child.matches('.wp-block-techcrunch-card')).slice(0, 50);
            const items = [];
            const byUrl = new Map();
            for (const [index, card] of cards.entries()) {
                if (card.closest('.ad, .advertisement, .ad-slot-container, .ad-unit, [data-ad], iframe')) continue;
                const links = [...card.querySelectorAll('.loop-card h3.loop-card__title a.loop-card__title-link[href]')]
                    .filter(link => link.closest('.wp-block-techcrunch-card') === card);
                if (links.length !== 1) throw rankingError('TechCrunch Top Headlines card has no unambiguous article link');
                const anchor = links[0];
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { continue; }
                if (!canonicalUrl || !isArticleUrl(canonicalUrl)) continue;
                const title = normalizeText(anchor.textContent).slice(0, 1_000);
                if (!title) continue;
                const previous = byUrl.get(canonicalUrl);
                if (previous) {
                    if (previous.title !== title) throw rankingError('TechCrunch Top Headlines contains conflicting article titles', 'TECHCRUNCH_RANKINGS_CONFLICT');
                    continue;
                }
                const item = { canonicalUrl, title, rank: index + 1 };
                byUrl.set(canonicalUrl, item);
                items.push(item);
            }
            if (!items.length) throw rankingError('TechCrunch Top Headlines contains no usable articles');
            if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) {
                throw rankingError('TechCrunch contains conflicting Top Headlines sections', 'TECHCRUNCH_RANKINGS_CONFLICT');
            }
            ranking = items;
        }
    }
    if (!ranking?.length) throw rankingError('TechCrunch page does not contain its Top Headlines selection');
    return { top_news: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('TechCrunch Top Headlines is unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 'techcrunch.com' || new URL(finalUrl).pathname !== '/') {
        throw new Error('TechCrunch Top Headlines has an invalid homepage source URL');
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('TechCrunch Top Headlines has no valid capture timestamp');
    }
    return {
        capturedAt: new Date(result.capturedAt).toISOString(),
        rankings: parseTechCrunchRankings(result.data?.values, finalUrl),
    };
}

export async function fetchTechCrunchRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '.hero-package-2__list', all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(TECHCRUNCH_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'TECHCRUNCH_RANKINGS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return parseCapture(await extract(TECHCRUNCH_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
