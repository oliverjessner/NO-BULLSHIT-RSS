import assert from 'node:assert/strict';
import test from 'node:test';
import { createRankingScheduler, readLastRankingAttempt, RANKING_REFRESH_INTERVAL_MS as INTERVAL, RANKING_DUE_CHECK_MS } from './ranking-scheduler.js';

const start = Date.parse('2026-11-01T00:00:00.000Z');

test('rankings run once at startup when missing, then only every eight hours', async () => {
    let now = start, stored = null, captures = 0;
    const scheduler = createRankingScheduler({ now: () => now, readLastAttempt: async () => stored,
        refresh: async () => { captures += 1; stored = now; } });
    assert.equal(await scheduler.check(), true);
    now += INTERVAL - 1;
    assert.equal(await scheduler.check(), false);
    now += 1;
    assert.equal(await scheduler.check(), true);
    assert.equal(captures, 2);
});

test('persisted all-media attempts and failed attempts survive a scheduler restart', async () => {
    for (const state of ['ready', 'error', 'refreshing']) {
        const stored = await readLastRankingAttempt({ all: async () => [{ value: JSON.stringify({ state, attemptedAt: new Date(start).toISOString() }) }] });
        let now = start + 5 * 60_000, captures = 0;
        const scheduler = createRankingScheduler({ now: () => now, readLastAttempt: async () => stored,
            refresh: async () => { captures += 1; } });
        assert.equal(await scheduler.check(), false);
        now = start + INTERVAL;
        assert.equal(await scheduler.check(), true);
        assert.equal(captures, 1);
    }
});

test('concurrent all-media updates reset the due time and running refreshes are not duplicated', async () => {
    let now = start + INTERVAL, stored = start, busy = true, captures = 0;
    const scheduler = createRankingScheduler({ now: () => now, readLastAttempt: async () => stored,
        isRefreshing: () => busy, refresh: async () => { captures += 1; } });
    assert.equal(await scheduler.check(), false);
    busy = false;
    stored = now; // Another all-media run finished.
    assert.equal(await scheduler.check(), false);
    now += INTERVAL;
    assert.equal(await scheduler.check(), true);
    assert.equal(captures, 1);
});

test('overlapping ticks share one refresh and failures wait eight hours before retrying', async () => {
    let finish, captures = 0, now = start;
    const scheduler = createRankingScheduler({ now: () => now, readLastAttempt: async () => null,
        refresh: () => { captures += 1; return new Promise((resolve, reject) => { finish = reject; }); } });
    const first = scheduler.check();
    const second = scheduler.check();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    finish(new Error('Publisher unavailable'));
    await assert.rejects(first, /Publisher unavailable/);
    now += 60_000;
    assert.equal(await scheduler.check(), false);
    assert.equal(captures, 1);
});

test('old captures provide restart timing and malformed metadata falls back safely', async () => {
    for (const value of [null, 'invalid JSON', '{"attemptedAt":"invalid"}']) {
        const queries = [];
        const stored = await readLastRankingAttempt({ all: async sql => {
            queries.push(sql);
            return sql.includes('app_metadata') ? [{ value }] : [{ capturedAt: new Date(start).toISOString() }];
        } });
        assert.equal(stored, start);
        assert.equal(queries.length, 2);
    }
    assert.equal(await readLastRankingAttempt({ all: async () => [] }), null);
});

test('clock rollback does not suspend captures or repeatedly refresh', async () => {
    let captures = 0;
    const scheduler = createRankingScheduler({ now: () => start, readLastAttempt: async () => start + INTERVAL,
        refresh: async () => { captures += 1; } });
    assert.equal(await scheduler.check(), true);
    assert.equal(await scheduler.check(), false);
    assert.equal(captures, 1);
});

test('the independent due timer starts once, can stop, and handles errors', async () => {
    let tick, cleared, scheduled = 0, errors = 0;
    const scheduler = createRankingScheduler({ readLastAttempt: async () => { throw new Error('DB unavailable'); },
        refresh: async () => {}, setTimer: (fn, delay) => { tick = fn; scheduled += 1; assert.equal(delay, RANKING_DUE_CHECK_MS); return 42; },
        clearTimer: id => { cleared = id; }, onError: () => { errors += 1; } });
    scheduler.start(); scheduler.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors, 1);
    tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors, 2);
    scheduler.stop();
    assert.equal(cleared, 42);
    assert.equal(scheduled, 1);
});

test('stopping while the due timestamp is loading prevents a later capture', async () => {
    let finishRead, captures = 0;
    const scheduler = createRankingScheduler({ readLastAttempt: () => new Promise(resolve => { finishRead = resolve; }),
        refresh: async () => { captures += 1; }, setTimer: () => 42, clearTimer: () => {} });
    scheduler.start();
    const pending = scheduler.check();
    scheduler.stop();
    finishRead(null);
    assert.equal(await pending, false);
    assert.equal(captures, 0);
});
