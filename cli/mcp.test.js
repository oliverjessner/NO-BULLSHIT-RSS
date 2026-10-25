import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createMcpHandler, runMcp } from './mcp.js';
import { MCP_TOOLS, callReadOnlyTool } from './mcp-tools.js';
import { openReadOnlyDatabase } from './lib/read-only-database.js';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const initialize = request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('MCP negotiates lifecycle and rejects unknown tools and write arguments', async () => {
    const handler = createMcpHandler();
    assert.equal((await handler(request(0, 'tools/list'))).error.code, -32000);
    assert.equal((await handler(initialize)).result.protocolVersion, '2025-06-18');
    assert.equal((await handler(request(2, 'tools/list'))).error.code, -32000);
    assert.equal(await handler(initialized), null);
    const list = (await handler(request(3, 'tools/list'))).result.tools;
    assert.equal(list.length, 15);
    assert.ok(list.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    for (const name of ['delete_watchdog', 'run_sql', 'run_cli', 'refresh_feed']) {
        assert.equal((await handler(request(4, 'tools/call', { name }))).error.code, -32602);
    }
    for (const args of [{ limit: 251 }, { archived: 'true' }, { watchdogId: '1 OR 1=1' }, { read: true }]) {
        assert.equal((await handler(request(5, 'tools/call', { name: 'get_watchdog_matches', arguments: args }))).error.code, -32602);
    }
    assert.equal((await handler(request(6, 'tools/call', { name: 'get_feed', arguments: { topic: 'ki', noTopic: true } }))).error.code, -32602);
    assert.equal((await handler(request(6, 'tools/call', { name: 'list_feeds', arguments: null }))).error.code, -32602);
    assert.deepEqual((await handler(request(7, 'ping'))).result, {});
    assert.equal((await handler(request(8, 'unknown'))).error.code, -32601);
});

test('MCP maps bounded tool arguments to CLI reads and reports read errors', async () => {
    let argv;
    const result = await callReadOnlyTool('get_watchdog_matches', { limit: 3, before: 12, status: 'unread', archived: true }, {
        runCommand: async (args, { stdout }) => { argv = args; stdout.write('{"matches":[],"hasMore":false}'); return 0; },
    });
    assert.deepEqual(argv, ['watchdog', 'matches', '--status', 'unread', '--limit', '3', '--before', '12', '--archived']);
    assert.deepEqual(result.structuredContent.result, { matches: [], hasMore: false });
    const failed = await callReadOnlyTool('get_digest', {}, { runCommand: async (_args, { stderr }) => { stderr.write('Missing database'); return 1; } });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /Missing database/);
    assert.equal(MCP_TOOLS.find(tool => tool.name === 'get_random_article').annotations.idempotentHint, false);
});

test('stdio handles split UTF-8, malformed JSON and notifications without extra output', async () => {
    const data = Buffer.from([JSON.stringify(initialize), JSON.stringify(initialized), '{broken',
        JSON.stringify(request(2, 'tools/call', { name: 'list_feeds', arguments: { label: 'Österreich' } })),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }),
        JSON.stringify(request(3, 'ping'))].join('\n') + '\n');
    const chunks = Array.from(data, byte => Buffer.from([byte]));
    let output = '';
    await runMcp({ input: Readable.from(chunks), output: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }) });
    const messages = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(messages.length, 4);
    assert.equal(messages[1].error.code, -32700);
    assert.equal(messages[2].error.code, -32602);
    assert.deepEqual(messages[3].result, {});
});

test('MCP subprocess reads real SQLite data and never creates a missing database', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nbs-mcp-'));
    const databasePath = path.join(directory, 'library.db');
    const entry = fileURLToPath(new URL('./no-bullshit-rss.js', import.meta.url));
    try {
        const database = new DatabaseSync(databasePath);
        try {
            for (const migration of ['0001_schema.sql', '0002_feed_names.sql', '0003_bullshit_rules.sql', '0006_watchdogs.sql']) {
                database.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
            }
            database.exec(`INSERT INTO sources (id, name, websiteUrl, canonicalWebsiteUrl, createdAt, updatedAt)
                VALUES (1, 'Example', 'https://example.com', 'https://example.com/', '2026-01-01', '2026-01-01');
                INSERT INTO feeds (id, sourceId, feedUrl, createdAt, updatedAt)
                VALUES (1, 1, 'https://example.com/rss', '2026-01-01', '2026-01-01'),
                       (2, 1, 'nbs-import:example', '2026-01-01', '2026-01-01');`);
        } finally { database.close(); }
        const before = await readFile(databasePath);
        const transcript = [initialize, initialized,
            request(2, 'tools/call', { name: 'count_feeds' }),
            request(3, 'tools/call', { name: 'get_feed' }),
            request(4, 'tools/call', { name: 'get_digest' }),
            request(5, 'tools/call', { name: 'list_watchdogs' })].map(message => JSON.stringify(message)).join('\n') + '\n';
        const run = dbPath => spawnSync(process.execPath, [entry, 'mcp'], {
            cwd: directory, env: { ...process.env, DB_PATH: dbPath }, input: transcript, encoding: 'utf8', timeout: 15_000,
        });
        const result = run(databasePath);
        assert.equal(result.status, 0, result.stderr);
        const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(messages[1].result.structuredContent.result, 1);
        for (const message of messages.slice(2)) assert.deepEqual(message.result.structuredContent.result, []);
        assert.deepEqual(await readFile(databasePath), before);
        const readOnly = await openReadOnlyDatabase(databasePath);
        try { await assert.rejects(() => readOnly.all('DELETE FROM feeds RETURNING id'), /readonly|read-only/i); }
        finally { await readOnly.close(); }
        const missing = run(path.join(directory, 'missing.db'));
        assert.equal(missing.status, 0, missing.stderr);
        assert.ok(missing.stdout.trim().split('\n').map(line => JSON.parse(line)).slice(1).every(message => message.result.isError));
        assert.deepEqual(await readdir(directory), ['library.db']);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
