import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';
import { configureRankingBrowser } from './ranking-browser.js';
import { logWarn } from '../utils/logger.js';

export const THEVERGE_RANKINGS_URL = 'https://www.theverge.com/#topStories';
const panelSelector = '#topStories-panel';
const heroSelector = '.duet--homepage--hero';
const cardSelector = '.duet--content-cards--content-card';
const excluded = '.ad, .advertisement, [data-ad], [data-concert], aside, nav, figure, picture, .duet--article--dangerously-set-cms-markup, .duet--article--timestamp, [class*="byline"], [class*="author"], [class*="metadata"]';
const normalizeText = value => String(value || '').replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
const reservedCategories = new Set(['author', 'authors', 'about', 'tag', 'tags', 'search', 'pages', 'newsletters', 'sponsored', 'advertising']);

function rankingError(message, code = 'THEVERGE_RANKINGS_MISSING') {
    const error = new Error(message);
    error.code = code;
    error.phase = 'parse';
    return error;
}

function isArticleUrl(value) {
    const url = new URL(value);
    if (hostname(value) !== 'theverge.com') return false;
    const modern = url.pathname.match(/^\/([a-z][a-z0-9-]*)(?:\/([a-z][a-z0-9-]*))?\/[1-9]\d*\/[^/]+\/?$/i);
    if (modern) return ![modern[1], modern[2]].some(category => reservedCategories.has(category?.toLowerCase()));
    const legacy = url.pathname.match(/^\/(?:([a-z][a-z0-9-]*)\/)?(\d{4})\/(\d{1,2})\/(\d{1,2})\/[1-9]\d*\/[^/]+\/?$/i);
    if (!legacy || reservedCategories.has(legacy[1]?.toLowerCase())) return false;
    const [, , year, month, day] = legacy;
    const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() === Number(year)
        && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day);
}

function headlineForCard(card, baseUrl) {
    const candidates = new Map();
    for (const anchor of card.querySelectorAll('a[href]')) {
        if (anchor.closest(cardSelector) !== card || anchor.closest(excluded)
            || anchor.matches('[aria-hidden="true"], [rel~="author"], [rel~="tag"]') || anchor.querySelector('img, picture, svg')) continue;
        const title = normalizeText(anchor.textContent).slice(0, 1_000);
        if (!title) continue;
        let canonicalUrl;
        try {
            const url = new URL(anchor.getAttribute('href'), baseUrl);
            if (/^#(?:comments?|responses?|replies)(?:\b|[-_])/i.test(url.hash)) continue;
            canonicalUrl = cleanHttpUrl(url.href);
        } catch { continue; }
        if (!canonicalUrl || !isArticleUrl(canonicalUrl)) continue;
        candidates.set(JSON.stringify([canonicalUrl, title]), { canonicalUrl, title });
    }
    if (candidates.size > 1) throw rankingError('The Verge Top Stories card has conflicting headlines', 'THEVERGE_RANKINGS_CONFLICT');
    return candidates.values().next().value || null;
}

function checkResponsiveOrder(entries, byUrl, hero) {
    const containers = new Map();
    for (const { card, canonicalUrl } of entries) {
        for (let parent = card.parentElement; parent && parent !== hero; parent = parent.parentElement) {
            if (!containers.has(parent)) containers.set(parent, []);
            containers.get(parent).push(byUrl.get(canonicalUrl).rank);
        }
    }
    // A structural desktop/mobile group with distinct stories must preserve the
    // same relative order. Mixed wrappers containing repeated variants are skipped.
    for (const ranks of containers.values()) {
        if (new Set(ranks).size === ranks.length && ranks.some((rank, index) => index && rank < ranks[index - 1])) {
            throw rankingError('The Verge Top Stories has conflicting responsive order', 'THEVERGE_RANKINGS_CONFLICT');
        }
    }
}

export function parseTheVergeRankings(fragments, baseUrl = THEVERGE_RANKINGS_URL) {
    let ranking = null;
    for (const fragment of fragments || []) {
        if (typeof fragment !== 'string' || !fragment.trim()) continue;
        const { document } = parseHTML(fragment);
        for (const panel of document.querySelectorAll(panelSelector)) {
            // The Top Stories tab also contains curated rivers and Most Popular;
            // only its leading hero is the editorial selection requested here.
            const heroes = [...panel.children].filter(child => child.matches(heroSelector));
            if (!heroes.length) throw rankingError('The Verge Top Stories hero is missing');
            for (const hero of heroes) {
                const items = [], entries = [], byUrl = new Map();
                const cards = [...hero.querySelectorAll(cardSelector)].filter(card => card.closest(heroSelector) === hero).slice(0, 50);
                for (const card of cards) {
                    if (card.closest(excluded)) continue;
                    const headline = headlineForCard(card, baseUrl);
                    if (!headline) continue;
                    entries.push({ card, canonicalUrl: headline.canonicalUrl });
                    const previous = byUrl.get(headline.canonicalUrl);
                    if (previous) {
                        if (previous.title !== headline.title) throw rankingError('The Verge Top Stories has conflicting responsive titles', 'THEVERGE_RANKINGS_CONFLICT');
                        continue;
                    }
                    const item = { ...headline, rank: items.length + 1 };
                    byUrl.set(item.canonicalUrl, item);
                    items.push(item);
                }
                if (!items.length) throw rankingError('The Verge Top Stories hero contains no usable articles');
                checkResponsiveOrder(entries, byUrl, hero);
                if (ranking && JSON.stringify(ranking) !== JSON.stringify(items)) {
                    throw rankingError('The Verge contains conflicting Top Stories heroes', 'THEVERGE_RANKINGS_CONFLICT');
                }
                ranking = items;
            }
        }
    }
    if (!ranking?.length) throw rankingError('The Verge page does not contain its Top Stories hero');
    return { top_news: ranking };
}

function parseCapture(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) throw new Error('The Verge Top Stories is unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl);
    if (!finalUrl || hostname(finalUrl) !== 'theverge.com' || new URL(finalUrl).pathname !== '/') {
        throw new Error('The Verge Top Stories has an invalid homepage source URL');
    }
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(Date.parse(result.capturedAt))) {
        throw new Error('The Verge Top Stories has no valid capture timestamp');
    }
    return { capturedAt: new Date(result.capturedAt).toISOString(), rankings: parseTheVergeRankings(result.data?.values, finalUrl) };
}

export async function fetchTheVergeRankings({
    extract = extractSelector,
    configureBrowser = extract === extractSelector ? configureRankingBrowser : null,
} = {}) {
    const signal = AbortSignal.timeout(30_000);
    const options = {
        selector: panelSelector, all: true, format: 'html', consent: 'accept',
        timeout: 12_000, signal, cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    };
    let httpFailure;
    try { return parseCapture(await extract(THEVERGE_RANKINGS_URL, { ...options, mode: 'http', waitAfterLoad: 0 })); }
    catch (error) {
        if (error.code !== 'THEVERGE_RANKINGS_MISSING') throw error;
        httpFailure = error;
    }
    try {
        signal.throwIfAborted();
        const browser = configureBrowser?.();
        if (browser?.warning) logWarn('Ranking browser fallback', { reason: browser.warning });
    } catch (error) { throw new Error(error.message, { cause: httpFailure }); }
    signal.throwIfAborted();
    return parseCapture(await extract(THEVERGE_RANKINGS_URL, { ...options, mode: 'browser', waitAfterLoad: 3_000 }));
}
