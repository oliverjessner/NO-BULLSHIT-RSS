import Parser from 'rss-parser';
import { decodeBuffer, detectEncoding } from '../utils/encoding.js';

const headers = {
    'User-Agent': 'no-bullshit-rss',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
};

export class RssFeedError extends Error {
    constructor(message, { status = null, retryable = false, cause } = {}) {
        super(message, { cause });
        this.name = 'RssFeedError';
        this.status = status;
        this.retryable = retryable;
    }
}

function httpError(status) {
    const detail = status === 429 ? ' (rate limit or automated-access protection)'
        : status === 403 ? ' (access denied)' : '';
    return new RssFeedError(`Feed server returned HTTP ${status}${detail}`, {
        status,
        retryable: status === 408 || status >= 500,
    });
}

export async function fetchRssFeed(url, { timeoutMs = 10_000, retries = 2, fetchImpl = fetch } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, { headers, signal: controller.signal });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw httpError(response.status);
            }

            const buffer = await response.arrayBuffer();
            const contentType = response.headers.get('content-type') || '';
            const snippet = Buffer.from(buffer).subarray(0, 512).toString('utf-8');
            const xml = decodeBuffer(buffer, detectEncoding(contentType, snippet));
            if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(xml)) {
                throw new RssFeedError('Feed server returned an HTML page instead of RSS or Atom');
            }
            try {
                return await new Parser().parseString(xml);
            } catch (cause) {
                throw new RssFeedError('Feed response is not valid RSS or Atom', { cause });
            }
        } catch (cause) {
            lastError = cause instanceof RssFeedError ? cause : new RssFeedError(
                controller.signal.aborted ? `Feed request timed out after ${timeoutMs} ms` : 'Feed request failed',
                { retryable: true, cause },
            );
            if (!lastError.retryable || attempt === retries) throw lastError;
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastError;
}
