import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanHttpUrl } from '../backend/utils/url.js';

test('Linkary removes tracking parameters and fragments without changing functional query values', () => {
    assert.equal(cleanHttpUrl(' https://example.com/story?UTM_Source=rss&id=a%20b&id=c+z&fbclid=123#comments '),
        'https://example.com/story?id=a%20b&id=c+z');
    for (const url of [
        'https://rss.golem.de/rss.php?feed=RSS2.0',
        'https://rss.sueddeutsche.de/rss/Wirtschaft?format=rss',
        'http://feeds.feedburner.com/d0od?format=xml',
    ]) assert.equal(cleanHttpUrl(`${url}&utm_medium=rss#top`), url);
});

test('URL cleaning rejects unsafe schemes, credentials and invalid URLs', () => {
    for (const url of ['', 'invalid', 'javascript:alert(1)', 'file:///tmp/test', 'https://user:pass@example.com/', 'https://example.com/' + 'x'.repeat(2_048)]) {
        assert.equal(cleanHttpUrl(url), null);
    }
});
