import { all, run } from '../db.js';
import { logInfo, logWarn } from '../utils/logger.js';

const MAX_LOGO_BYTES = 200 * 1024;

function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractIconHref(html) {
  if (!html) return null;
  const linkRegex = /<link\s+[^>]*rel=["']?([^"'>]+)["']?[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const rel = match[1].toLowerCase();
    if (!rel.includes('icon')) continue;
    const tag = match[0];
    const hrefMatch = tag.match(/href=["']?([^"'>\s]+)["']?/i);
    if (hrefMatch && hrefMatch[1]) return hrefMatch[1];
  }
  return null;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSiteLogo(websiteUrl) {
  let iconUrl = null;

  try {
    const res = await fetchWithTimeout(websiteUrl, 6000);
    if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
      const html = await res.text();
      const href = extractIconHref(html);
      iconUrl = href ? resolveUrl(href, websiteUrl) : null;
    }
  } catch (err) {
    logWarn('Website HTML fetch failed', { websiteUrl, error: err.message });
  }

  if (!iconUrl) {
    try {
      const origin = new URL(websiteUrl).origin;
      iconUrl = `${origin}/favicon.ico`;
    } catch {
      return null;
    }
  }

  try {
    const res = await fetchWithTimeout(iconUrl, 8000);
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || '';
    if (!mime.startsWith('image/')) return null;
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_LOGO_BYTES) return null;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_LOGO_BYTES) return null;
    return { buffer: Buffer.from(arrayBuffer), mime };
  } catch (err) {
    logWarn('Logo fetch failed', { iconUrl, error: err.message });
    return null;
  }
}

export async function refreshAllFeedLogos() {
  const feeds = await all('SELECT id, websiteUrl FROM feeds ORDER BY id');
  let updated = 0;

  for (const feed of feeds) {
    const logo = await fetchSiteLogo(feed.websiteUrl);
    if (!logo) {
      logWarn('Logo not found', { feedId: feed.id });
      continue;
    }
    await run(
      "UPDATE feeds SET logo = ?, logoMime = ?, updatedAt = datetime('now') WHERE id = ?",
      [logo.buffer, logo.mime, feed.id]
    );
    updated += 1;
    logInfo('Logo updated', { feedId: feed.id });
  }

  logInfo('Logo refresh finished', { updated, total: feeds.length });
}
