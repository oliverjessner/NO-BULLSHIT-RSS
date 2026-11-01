import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const GOLEM_RANKINGS_URL = 'https://www.golem.de/';
export const RANKING_KEYS = Object.freeze(['most_read', 'most_commented']);
const headings = new Map([
    ['Meistgelesene Artikel', 'most_read'],
    ['Meistkommentierte Artikel', 'most_commented'],
]);
const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

export class GolemConsentRequiredError extends Error {
    constructor(cause) {
        super('Automatic Golem consent could not be completed. Try refreshing again.', { cause });
        this.name = 'GolemConsentRequiredError';
        this.code = 'GOLEM_CONSENT_REQUIRED';
        this.phase = 'consent';
        this.retryable = false;
    }
}

function missingRankings(message) {
    const error = new Error(message);
    error.code = 'GOLEM_RANKINGS_MISSING';
    error.phase = 'parse';
    return error;
}

export function isGolemSource(source) {
    const url = cleanHttpUrl(source?.websiteUrl);
    return Boolean(url && hostname(url) === 'golem.de');
}

export function parseGolemRankings(fragments, baseUrl = GOLEM_RANKINGS_URL) {
    const rankings = {};
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const block of document.querySelectorAll('.go-teaser-block')) {
            const heading = normalizeText(block.querySelector('.go-teaser-block__heading h3, .go-teaser-block__header h3')?.textContent);
            const rankingKey = headings.get(heading);
            if (!rankingKey) continue;
            const items = [];
            const urls = new Set();
            const articles = [...block.querySelectorAll('article.go-teaser')].slice(0, 50);
            articles.forEach((article, index) => {
                const anchor = article.querySelector('h2 a.go-teaser__link[href]');
                if (!anchor) return;
                let canonicalUrl;
                try { canonicalUrl = cleanHttpUrl(new URL(anchor.getAttribute('href'), baseUrl).href); }
                catch { return; }
                if (!canonicalUrl || hostname(canonicalUrl) !== 'golem.de' || !new URL(canonicalUrl).pathname.startsWith('/news/')) return;
                const title = normalizeText(anchor.textContent).slice(0, 1_000);
                if (!title || urls.has(canonicalUrl)) return;
                urls.add(canonicalUrl);
                items.push({ canonicalUrl, title, rank: index + 1 });
            });
            if (!items.length) throw missingRankings(`Golem ${rankingKey} contains no usable articles`);
            if (rankings[rankingKey] && JSON.stringify(rankings[rankingKey]) !== JSON.stringify(items)) {
                throw new Error(`Golem ${rankingKey} contains conflicting ranking blocks`);
            }
            rankings[rankingKey] = items;
        }
    }
    if (RANKING_KEYS.some(key => !rankings[key]?.length)) throw missingRankings('Golem page does not contain both article rankings');
    return rankings;
}

function parseCapture(result) {
    const finalUrl = cleanHttpUrl(result.finalUrl || GOLEM_RANKINGS_URL);
    if (!finalUrl || hostname(finalUrl) !== 'golem.de') throw new Error('Golem rankings redirected to another site');
    const pathname = new URL(finalUrl).pathname;
    // Golem's anonymous HTTP response can be a successful redirect to
    // /sonstiges/zustimmung/auswahl.html rather than the requested homepage.
    if ((result.consent?.status !== 'handled' && /(?:^|\/)(?:zustimmung|consent|cookie-consent|cookie-wall)(?:[/.\-_]|$)/i.test(pathname))
        || result.consent?.status === 'blocked') throw new GolemConsentRequiredError();
    if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300) throw new Error('Golem rankings are unavailable');
    let rankings;
    try { rankings = parseGolemRankings(result.data?.values, finalUrl); }
    catch (error) {
        if (error.code === 'GOLEM_RANKINGS_MISSING' && result.consent?.detected && result.consent.status !== 'handled') throw new GolemConsentRequiredError(error);
        throw error;
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(new Date(result.capturedAt).getTime())) {
        throw new Error('Golem rankings have no valid capture timestamp');
    }
    return { capturedAt: new Date(result.capturedAt).toISOString(), rankings };
}

export async function fetchGolemRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: '.go-teaser-block', all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000,
        maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try {
        return parseCapture(await extract(GOLEM_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 }));
    } catch (error) {
        // Fetchary auto mode tests whether any generic teaser block matched.
        // Validate both required sections before deciding to render instead.
        // Golem's cookie choice needs a real browser interaction. The selected
        // accept policy applies to this publisher's capture only.
        if (!['GOLEM_RANKINGS_MISSING', 'GOLEM_CONSENT_REQUIRED'].includes(error.code)) throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) {
        throw new Error(error.message, { cause: httpFailure });
    }
    signal.throwIfAborted();
    return parseCapture(await extract(GOLEM_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
