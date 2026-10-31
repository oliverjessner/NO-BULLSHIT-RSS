import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-default-rules-'));
process.env.DB_PATH = path.join(directory, 'defaults.db');
const database = await import('../backend/database/datenbank.js');
const { DEFAULT_BULLSHIT_RULES_MARKER, seedDefaultBullshitRules } = await import('./default-bullshit-rules.js');
const { getActiveBullshitRules } = await import('../backend/services/bullshit-rules.js');
const legacyDefaults = await readFile(new URL('../migrations/0004_default_bullshit_rules.sql', import.meta.url), 'utf8');

test.before(async () => database.initSchema());
test.beforeEach(async () => {
    await database.run('DELETE FROM digest_periods');
    await database.run('DELETE FROM sources');
    await database.run('DELETE FROM bullshit_rules');
    await database.run('DELETE FROM app_metadata WHERE key = ?', [DEFAULT_BULLSHIT_RULES_MARKER]);
    await database.exec(legacyDefaults);
    await getActiveBullshitRules({ force: true });
});
test.after(async () => {
    await database.closeDatabase();
    await rm(directory, { recursive: true, force: true });
});

test('fresh installs receive all 13 enabled production rules and remove only the obsolete fresh-install template', async () => {
    assert.deepEqual(await seedDefaultBullshitRules(database, { fresh: true }), { applied: true, rulesAdded: 10, rulesEnabled: 3 });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM bullshit_rules')).count, 13);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM bullshit_rules WHERE enabled = 1')).count, 13);
    assert.equal(await database.get("SELECT id FROM bullshit_rules WHERE name = 'SEO List'"), undefined);
    assert.equal((await getActiveBullshitRules()).length, 13);
    assert.equal((await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_BULLSHIT_RULES_MARKER])).value, '1');
});

test('existing installs preserve disabled, renamed and edited rules while deduplicating names and expressions case-insensitively', async () => {
    await database.exec(`UPDATE bullshit_rules SET value = 'My promotion filter', updatedAt = '2000-01-01' WHERE name = 'Black Friday';
        UPDATE bullshit_rules SET name = 'My sponsored choice', updatedAt = '2000-01-01' WHERE name = 'Sponsored';
        INSERT INTO bullshit_rules (name, enabled, field, operator, value, createdAt, updatedAt)
        VALUES ('My coupons', 0, 'title', 'contains', 'COUPON', '2000-01-01', '2000-01-01');`);
    const preferences = await database.all('SELECT * FROM bullshit_rules ORDER BY id');

    await seedDefaultBullshitRules(database);

    for (const original of preferences) assert.deepEqual(await database.get('SELECT * FROM bullshit_rules WHERE id = ?', [original.id]), original);
    assert.equal((await database.get("SELECT COUNT(*) AS count FROM bullshit_rules WHERE name = 'Sponsored'")).count, 0);
    assert.equal((await database.get("SELECT COUNT(*) AS count FROM bullshit_rules WHERE field = 'title' AND operator = 'contains' AND lower(value) = 'coupon'")).count, 1);
    assert.equal((await database.get("SELECT enabled FROM bullshit_rules WHERE name = 'SEO List'")).enabled, 0);
});

test('completed seeding respects intentionally deleted defaults on later launches', async () => {
    await seedDefaultBullshitRules(database, { fresh: true });
    await database.run("DELETE FROM bullshit_rules WHERE name = 'Coupon'");

    assert.deepEqual(await seedDefaultBullshitRules(database), { applied: false, rulesAdded: 0, rulesEnabled: 0 });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM bullshit_rules')).count, 12);
    assert.equal(await database.get("SELECT id FROM bullshit_rules WHERE name = 'Coupon'"), undefined);
});

test('new rules refresh cached evaluation, classify existing articles and dirty open digests', async () => {
    await database.exec(`INSERT INTO sources (name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
        VALUES ('Publisher', 'https://publisher.example/', 'https://publisher.example/', datetime('now'), datetime('now'));
        INSERT INTO feeds (sourceId, name, feedUrl, createdAt, updatedAt)
        SELECT id, 'Publisher', 'https://publisher.example/rss', datetime('now'), datetime('now') FROM sources;
        INSERT INTO articles (feedId, externalId, title, contentHash, publishedAt, fetchedAt, createdAt, updatedAt)
        SELECT id, 'promotion', 'Coupon promotion', 'hash', '2026-10-31T12:00:00Z', datetime('now'), datetime('now'), datetime('now') FROM feeds;
        INSERT INTO digest_periods (type, periodKey, startsAt, endsAt, timezone, status, algorithmVersion, rulesVersion, createdAt, updatedAt)
        VALUES ('day', '2026-10-31', '2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z', 'Europe/Vienna', 'ready', 'test', 'test', datetime('now'), datetime('now')),
               ('day', '2020-01-01', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', 'Europe/Vienna', 'closed', 'test', 'test', datetime('now'), datetime('now'));`);
    assert.equal((await getActiveBullshitRules()).length, 0);

    await seedDefaultBullshitRules(database);

    assert.deepEqual(await database.all(
        'SELECT rules.name FROM article_bullshit_matches AS matches JOIN bullshit_rules AS rules ON rules.id = matches.ruleId ORDER BY rules.name',
    ), [{ name: 'Coupon' }]);
    assert.ok((await getActiveBullshitRules()).some(rule => rule.name === 'Coupon'));
    assert.ok((await database.get("SELECT dirtyAt FROM digest_periods WHERE status = 'ready'")).dirtyAt);
    assert.equal((await database.get("SELECT dirtyAt FROM digest_periods WHERE status = 'closed'")).dirtyAt, null);
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
});

test('failed inserts roll back all defaults and retain fresh-install recovery state', async () => {
    await database.run("INSERT INTO app_metadata (key, value, updatedAt) VALUES (?, 'fresh', datetime('now'))", [DEFAULT_BULLSHIT_RULES_MARKER]);
    const original = await database.all('SELECT * FROM bullshit_rules ORDER BY id');
    await database.exec(`CREATE TRIGGER reject_default_rule BEFORE INSERT ON bullshit_rules
        WHEN NEW.name = 'Coupon' BEGIN SELECT RAISE(ABORT, 'rule seed failure'); END;`);
    try {
        await assert.rejects(seedDefaultBullshitRules(database), /rule seed failure/);
        assert.deepEqual(await database.all('SELECT * FROM bullshit_rules ORDER BY id'), original);
        assert.equal((await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_BULLSHIT_RULES_MARKER])).value, 'fresh');
    } finally {
        await database.exec('DROP TRIGGER reject_default_rule');
    }
    await seedDefaultBullshitRules(database);
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM bullshit_rules WHERE enabled = 1')).count, 13);
});

test('interrupted evaluation retries without reinserting rules and completes the pending marker', async () => {
    await assert.rejects(seedDefaultBullshitRules(database, {
        fresh: true,
        reevaluate: async () => { throw new Error('evaluation interrupted'); },
    }), /evaluation interrupted/);
    assert.equal((await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_BULLSHIT_RULES_MARKER])).value, 'pending');
    await database.run("DELETE FROM bullshit_rules WHERE name = 'Coupon'");

    assert.deepEqual(await seedDefaultBullshitRules(database), { applied: false, rulesAdded: 0, rulesEnabled: 0 });
    assert.equal((await database.get('SELECT COUNT(*) AS count FROM bullshit_rules')).count, 12);
    assert.equal((await database.get('SELECT value FROM app_metadata WHERE key = ?', [DEFAULT_BULLSHIT_RULES_MARKER])).value, '1');
});
