import { decodeBuffer, detectEncoding } from '../utils/encoding.js';

// WinFuture's shipped wfv4_hp_tabs() loads its public "Meistgelesene" tab
// through this read endpoint with pager=1 (the homepage's first page).
export const WINFUTURE_POPULAR_URL = 'https://winfuture.de/ajax/homepage/hp_top';
const MAX_BYTES = 1024 * 1024;

export async function fetchWinFuturePopularHtml({ fetchImpl = fetch, signal } = {}) {
    const deadline = AbortSignal.timeout(12_000);
    const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let reader;
    try {
        combinedSignal.throwIfAborted();
        const response = await fetchImpl(WINFUTURE_POPULAR_URL, {
            method: 'POST', body: 'pager=1', redirect: 'manual', signal: combinedSignal,
            headers: {
                'User-Agent': 'no-bullshit-rss',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest', Referer: 'https://winfuture.de/',
            },
        });
        reader = response.body?.getReader();
        const finalUrl = new URL(response.url || WINFUTURE_POPULAR_URL);
        if (response.status !== 200 || finalUrl.href !== WINFUTURE_POPULAR_URL) throw new Error('Unexpected WinFuture popular-tab response');
        const contentType = response.headers.get('content-type') || '';
        if (!/^(?:application\/json|text\/(?:json|html))(?:;|$)/i.test(contentType)) throw new Error('Unexpected WinFuture popular-tab content type');
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('WinFuture popular-tab response is too large');
        const chunks = [];
        let size = 0;
        if (reader) while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('WinFuture popular-tab response is too large');
            chunks.push(Buffer.from(value));
        }
        const buffer = Buffer.concat(chunks, size);
        const data = JSON.parse(decodeBuffer(buffer, detectEncoding(contentType, '')));
        combinedSignal.throwIfAborted();
        if (!data || typeof data.html !== 'string' || !data.html.trim() || Object.hasOwn(data, 'error')) throw new Error('Invalid WinFuture popular-tab content');
        return { html: data.html, capturedAt: new Date().toISOString() };
    } catch (cause) {
        const error = new Error('WinFuture popular articles could not be loaded', { cause });
        error.code = 'WINFUTURE_POPULAR_UNAVAILABLE';
        error.phase = 'http';
        throw error;
    } finally {
        await reader?.cancel().catch(() => {});
    }
}
