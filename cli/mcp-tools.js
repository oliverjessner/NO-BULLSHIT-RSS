import Ajv from 'ajv';
import { runCli } from './main.js';
import { WATCHDOG_RANGES } from '../backend/services/watchdog-filters.js';

const count = { type: 'integer', minimum: 1, maximum: 250 };
const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const text = { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' };
const tool = (name, description, properties, required, args) => ({
    name, description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    args,
});

// Explicit mappings only: never accept arbitrary CLI arguments, SQL or paths.
const definitions = [
    tool('get_statistics', 'Read stored article totals and top feeds/topics.', {}, [], () => ['stats', '--json']),
    tool('list_feeds', 'Read stored RSS feed names and URLs, excluding imported-link sources.', {}, [], () => ['rss']),
    tool('count_feeds', 'Count saved RSS feeds, excluding imported-link sources.', {}, [], () => ['rss', '--amount']),
    tool('list_topics', 'Read stored topic definitions.', {}, [], () => ['topics']),
    tool('list_lists', 'Read stored lists and article counts.', {}, [], () => ['lists']),
    tool('get_list_articles', 'Read stored articles from a named list. Names are case-insensitive.', { name: text }, ['name'], a => ['lists', '--list', a.name]),
    tool('get_feed', 'Read newest saved articles, optionally filtered by topic or noTopic. Does not mark articles read.',
        { count, topic: text, noTopic: { type: 'boolean' } }, [], a => ['articles', 'last', String(a.count ?? 50),
            ...(a.topic === undefined ? [] : ['--topic', a.topic]), ...(a.noTopic ? ['--no-topic'] : [])]),
    tool('get_random_article', 'Read one random saved article.', {}, [], () => ['articles', 'random']),
    tool('search_articles', 'Search stored article titles or URLs, newest first.',
        { count, field: { type: 'string', enum: ['title', 'url'] }, text }, ['field', 'text'],
        a => ['articles', 'search', String(a.count ?? 50), `--${a.field}`, a.text]),
    tool('get_digest', 'Read saved daily, weekly or monthly digest clusters. Never generates or refreshes a digest.',
        { count, range: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } }, [],
        a => ['articles', 'digest', String(a.count ?? 50), `--${a.range ?? 'daily'}`]),
    tool('list_watchdogs', 'Read Watchdog rules and unread counts.', {}, [], () => ['watchdog', 'list']),
    tool('get_watchdog', 'Read one Watchdog rule.', { id }, ['id'], a => ['watchdog', 'show', String(a.id)]),
    tool('get_watchdog_match', 'Read one saved Watchdog match without marking it read.', { id }, ['id'], a => ['watchdog', 'match', String(a.id)]),
    tool('get_watchdog_notifications', 'Read the saved Watchdog notification preference. Does not send notifications.', {}, [], () => ['watchdog', 'notifications']),
    tool('get_watchdog_matches', 'Read Watchdog matches, newest match ID first. Use before with the last match ID when hasMore is true. Archived defaults to false.',
        { watchdogId: id, status: { type: 'string', enum: ['all', 'unread', 'read'] }, archived: { type: 'boolean' },
            range: { type: 'string', enum: WATCHDOG_RANGES }, limit: count, before: id,
            asOf: { type: 'integer', minimum: 1, maximum: 8_640_000_000_000_000 } }, [], a => {
            const args = ['watchdog', 'matches'];
            for (const [key, flag] of Object.entries({ watchdogId: '--watchdog', status: '--status', range: '--range', limit: '--limit', before: '--before', asOf: '--as-of' })) {
                if (a[key] !== undefined) args.push(flag, String(a[key]));
            }
            if (a.archived) args.push('--archived');
            return args;
        }),
];

const ajv = new Ajv({ allErrors: true });
const validators = new Map(definitions.map(definition => [definition.name, ajv.compile(definition.inputSchema)]));
export const MCP_TOOLS = definitions.map(({ args, ...definition }) => definition);
MCP_TOOLS.find(definition => definition.name === 'get_random_article').annotations.idempotentHint = false;

export async function callReadOnlyTool(name, input = {}, { runCommand = runCli, cliOptions = {} } = {}) {
    const definition = definitions.find(item => item.name === name);
    if (!definition) throw Object.assign(new Error(`Unknown read-only tool: ${name}`), { rpcCode: -32602 });
    const validate = validators.get(name);
    if (!validate(input)) throw Object.assign(new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`), { rpcCode: -32602 });
    if (input.topic && input.noTopic) throw Object.assign(new Error('Only one of topic or noTopic may be used.'), { rpcCode: -32602 });
    let stdout = '', stderr = '';
    const maxOutputBytes = 4 * 1024 * 1024;
    let bytes = 0;
    const capture = { write(value) {
        bytes += Buffer.byteLength(String(value));
        if (bytes > maxOutputBytes) throw new Error('Result exceeds 4 MiB. Request fewer articles or a narrower filter.');
        stdout += String(value);
    } };
    const exitCode = await runCommand(definition.args(input), {
        ...cliOptions, stdout: capture, stderr: { write(value) { stderr += String(value); } },
        chooseArticle: () => { throw new Error('Interactive selection is unavailable over MCP.'); },
    });
    if (exitCode) return { isError: true, content: [{ type: 'text', text: stderr.trim() || 'Read failed.' }] };
    const result = JSON.parse(stdout);
    const response = { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } };
    if (Buffer.byteLength(JSON.stringify(response)) > maxOutputBytes) {
        return { isError: true, content: [{ type: 'text', text: 'Result exceeds 4 MiB. Request fewer articles or a narrower filter.' }] };
    }
    return response;
}
