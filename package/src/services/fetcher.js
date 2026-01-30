import Parser from 'rss-parser';
import crypto from 'node:crypto';
import { all, run } from '../db.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { publish } from './events.js';
import { decodeBuffer, detectEncoding } from '../utils/encoding.js';

const parser = new Parser({ timeout: 8000 });

let lastFetchStatus = {
  at: null,
  durationMs: null,
  totalNew: 0,
  error: null
};

export function getLastFetchStatus() {
  return lastFetchStatus;
}

function toIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeTeaser(text, maxLen = 220) {
  if (!text) return null;
  const cleaned = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

async function fetchWithRetry(url, { timeoutMs = 10000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      const contentType = res.headers.get('content-type') || '';
      const snippet = Buffer.from(arrayBuffer).subarray(0, 512).toString('utf-8');
      const encoding = detectEncoding(contentType, snippet);
      const text = decodeBuffer(arrayBuffer, encoding);
      return text;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export async function updateAllFeeds() {
  const start = Date.now();
  logInfo('Fetch run started');

  const feeds = await all('SELECT * FROM feeds ORDER BY id');
  let totalNew = 0;
  let errorMessage = null;

  try {
    for (const feed of feeds) {
      const feedStart = Date.now();
      try {
        const xml = await fetchWithRetry(feed.feedUrl, { timeoutMs: 10000, retries: 2 });
        const parsed = await parser.parseString(xml);
        let newCount = 0;

        for (const item of parsed.items || []) {
          const url = item.link || item.id || null;
          const guid = item.guid || item.id || url || '';
          const guidOrHash = guid ? String(guid) : (url ? hashUrl(url) : null);
          if (!guidOrHash) continue;

          const publishedAt = toIsoDate(item.isoDate || item.pubDate || item.published);
          const teaser = normalizeTeaser(item.contentSnippet || item.summary || item.content || item.description);

          try {
            const result = await run(
              `INSERT OR IGNORE INTO articles
              (feedId, title, teaser, url, publishedAt, guidOrHash)
              VALUES (?, ?, ?, ?, ?, ?)` ,
              [feed.id, item.title || null, teaser, url, publishedAt, guidOrHash]
            );
            if (result.changes > 0) newCount += 1;
          } catch (err) {
            logWarn('Article insert failed', { feedId: feed.id, error: err.message });
          }
        }

        totalNew += newCount;
        logInfo('Feed updated', { feedId: feed.id, newCount, ms: Date.now() - feedStart });
      } catch (err) {
        logError('Feed failed', { feedId: feed.id, error: err.message, ms: Date.now() - feedStart });
      }
    }
  } catch (err) {
    errorMessage = err.message;
    throw err;
  } finally {
    lastFetchStatus = {
      at: new Date().toISOString(),
      durationMs: Date.now() - start,
      totalNew,
      error: errorMessage
    };
    logInfo('Fetch run finished', { totalNew, ms: Date.now() - start });
    publish('fetch.completed', { ...lastFetchStatus });
  }
}
