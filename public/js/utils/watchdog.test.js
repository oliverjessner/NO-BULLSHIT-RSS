import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWatchdogTerms, enableWatchdogNotifications } from './watchdog.js';
test('watchdog terms accept lines and commas, trim whitespace and preserve literal phrases', () => {
    assert.deepEqual(parseWatchdogTerms(' OpenAI, AI safety\nLLM\n OpenAI, '), ['OpenAI', 'AI safety', 'LLM']);
    assert.deepEqual(parseWatchdogTerms(null), []);
    assert.deepEqual(parseWatchdogTerms('.*[literal]'), ['.*[literal]']);
});


test('notification permission must succeed before its enabled preference is persisted', async () => {
    const steps = [];
    assert.equal(await enableWatchdogNotifications(async () => { steps.push('permission'); return 'granted'; }, async enabled => { steps.push(enabled); }), 'granted');
    assert.deepEqual(steps, ['permission', true]);
    for (const permission of ['denied', 'unavailable', 'prompt']) {
        await assert.rejects(enableWatchdogNotifications(async () => permission, () => assert.fail('Unexpected save')), /Notifications denied|permissions are unavailable/);
    }
    await assert.rejects(enableWatchdogNotifications(async () => { throw new Error('Native bridge failure'); }, () => assert.fail('Unexpected save')), /Native bridge failure/);
    await assert.rejects(enableWatchdogNotifications(async () => 'granted', async () => { throw new Error('Could not save preference'); }), /Could not save preference/);
});
