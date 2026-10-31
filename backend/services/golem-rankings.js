import { extractSelector } from 'fetchary';
import { parseHTML } from 'linkedom';
import { cleanHttpUrl } from '../utils/url.js';

export const GOLEM_RANKINGS_URL = 'https://www.golem.de/';
export const RANKING_KEYS = Object.freeze(['most_read', 'most_commented']);
const headings = new Map([
    ['Meistgelesene Artikel', 'most_read'],
    ['Meistkommentierte Artikel', 'most_commented'],
]);
const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();
const hostname = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');

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
            if (!items.length) throw new Error(`Golem ${rankingKey} contains no usable articles`);
            if (rankings[rankingKey] && JSON.stringify(rankings[rankingKey]) !== JSON.stringify(items)) {
                throw new Error(`Golem ${rankingKey} contains conflicting ranking blocks`);
            }
            rankings[rankingKey] = items;
        }
    }
    if (RANKING_KEYS.some(key => !rankings[key]?.length)) throw new Error('Golem page does not contain both article rankings');
    return rankings;
}

export async function fetchGolemRankings({ extract = extractSelector } = {}) {
    const result = await extract(GOLEM_RANKINGS_URL, {
        selector: '.go-teaser-block', all: true, format: 'html', mode: 'auto', consent: 'off',
        timeout: 12_000, waitAfterLoad: 0, signal: AbortSignal.timeout(15_000),
        cacheTtlMs: 60_000, maxResponseBytes: 3 * 1024 * 1024, insecure: false,
    });
    if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || result.consent?.status === 'blocked') throw new Error('Golem rankings are unavailable');
    const finalUrl = cleanHttpUrl(result.finalUrl || GOLEM_RANKINGS_URL);
    if (!finalUrl || hostname(finalUrl) !== 'golem.de') throw new Error('Golem rankings redirected to another site');
    const rankings = parseGolemRankings(result.data?.values, finalUrl);
    if (typeof result.capturedAt !== 'string' || !result.capturedAt.trim() || !Number.isFinite(new Date(result.capturedAt).getTime())) {
        throw new Error('Golem rankings have no valid capture timestamp');
    }
    const capturedAt = new Date(result.capturedAt).toISOString();
    return { capturedAt, rankings };
}
