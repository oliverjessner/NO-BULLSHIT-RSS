import { all, get, run } from '../database/datenbank.js';
import { canonicalizeArticleUrl } from '../routes/digest.js';
import { ingestArticle } from './article-ingest.js';
import { cleanHttpUrl } from '../utils/url.js';

export const MANUAL_IMPORT_FEED_PREFIX = 'nbs-import:';

export function isManualImportFeedUrl(value) {
    return String(value || '').startsWith(MANUAL_IMPORT_FEED_PREFIX);
}

export function normalizeImportUrl(value) {
    return cleanHttpUrl(value);
}

export function normalizeImportDomain(value) {
    try {
        return new URL(value).hostname.toLowerCase().replace(/\.$/u, '').replace(/^www\./u, '');
    } catch {
        return null;
    }
}

export function deriveImportedArticleTitle(value) {
    const url = new URL(value);
    const segment = url.pathname.split('/').filter(Boolean).at(-1) || '';
    let title = segment;
    try { title = decodeURIComponent(segment); } catch { /* Keep the encoded path segment. */ }
    title = title
        .replace(/\.(?:s?html?|php|aspx?)$/iu, '')
        .replace(/[-_]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return (title || url.hostname.replace(/^www\./iu, '')).slice(0, 1_000);
}

async function ensureImportFeed(articleUrl) {
    const url = new URL(articleUrl);
    const websiteUrl = new URL('/', url.origin).toString();
    const fallbackName = url.hostname.replace(/^www\./iu, '') || 'Imported';
    await run(
        `INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(canonicalWebsiteUrl) DO UPDATE SET updatedAt = datetime('now')`,
        [fallbackName, websiteUrl, websiteUrl],
    );
    const source = await get('SELECT id, name FROM sources WHERE canonicalWebsiteUrl = ?', [websiteUrl]);
    const feedUrl = `${MANUAL_IMPORT_FEED_PREFIX}${url.origin}`;
    const feedName = `${source?.name || fallbackName} (Imported)`;
    await run(
        `INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(feedUrl) DO UPDATE SET sourceId = excluded.sourceId, name = excluded.name, updatedAt = datetime('now')`,
        [source.id, feedName, feedUrl],
    );
    return get('SELECT id FROM feeds WHERE feedUrl = ?', [feedUrl]);
}

async function loadImportFeedIndex() {
    const feeds = await all(
        `SELECT feeds.id, feeds.feedUrl, sources.websiteUrl
         FROM feeds
         JOIN sources ON sources.id = feeds.sourceId
         WHERE feeds.feedUrl NOT LIKE ?
         ORDER BY feeds.id ASC`,
        [`${MANUAL_IMPORT_FEED_PREFIX}%`],
    );
    const index = new Map();
    for (const feed of feeds) {
        const domain = normalizeImportDomain(feed.websiteUrl);
        if (domain && !index.has(domain)) index.set(domain, { id: Number(feed.id) });
    }
    for (const feed of feeds) {
        const domain = normalizeImportDomain(feed.feedUrl);
        if (domain && !index.has(domain)) index.set(domain, { id: Number(feed.id) });
    }
    return index;
}

async function loadExistingImportUrls() {
    // Older releases only removed a short, case-sensitive tracking list and
    // re-encoded query values. Recognize both stored forms during upgrades.
    const rows = await all('SELECT id, canonicalUrl, url FROM articles ORDER BY id');
    const index = new Map();
    for (const row of rows) {
        for (const value of [row.canonicalUrl, row.url]) {
            const canonicalUrl = cleanHttpUrl(value);
            if (canonicalUrl && !index.has(canonicalUrl)) index.set(canonicalUrl, { id: Number(row.id) });
        }
    }
    return index;
}

export async function importArticlesFromUrls(values) {
    const inputs = Array.isArray(values) ? values : [];
    const result = { received: inputs.length, imported: 0, duplicates: 0, invalid: 0, failed: 0, articleIds: [], issues: [] };
    const seen = new Set();
    const feedByDomain = await loadImportFeedIndex();
    let existingImportUrls;

    for (let index = 0; index < inputs.length; index += 1) {
        const url = normalizeImportUrl(inputs[index]);
        if (!url) {
            result.invalid += 1;
            result.issues.push({ index, reason: 'Invalid HTTP(S) URL' });
            continue;
        }
        const canonicalUrl = canonicalizeArticleUrl(url) || url;
        if (seen.has(canonicalUrl)) {
            result.duplicates += 1;
            continue;
        }
        seen.add(canonicalUrl);

        let existing = await get('SELECT id FROM articles WHERE canonicalUrl = ? ORDER BY id ASC LIMIT 1', [canonicalUrl]);
        if (!existing) {
            existingImportUrls ??= await loadExistingImportUrls();
            existing = existingImportUrls.get(canonicalUrl);
        }
        if (existing) {
            result.duplicates += 1;
            result.articleIds.push(Number(existing.id));
            continue;
        }

        try {
            const domain = normalizeImportDomain(url);
            let feed = feedByDomain.get(domain);
            if (!feed) {
                feed = await ensureImportFeed(url);
                if (domain) feedByDomain.set(domain, feed);
            }
            const imported = await ingestArticle({
                feedId: Number(feed.id),
                externalId: canonicalUrl,
                title: deriveImportedArticleTitle(url),
                url,
                publishedAt: new Date().toISOString(),
            });
            if (imported.inserted) result.imported += 1;
            else result.duplicates += 1;
            result.articleIds.push(Number(imported.id));
        } catch {
            result.failed += 1;
            result.issues.push({ index, reason: 'Could not store article' });
        }
    }

    result.articleIds = [...new Set(result.articleIds)];
    return result;
}
