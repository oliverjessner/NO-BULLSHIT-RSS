import { readFileSync } from 'node:fs';

export const CLI_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const HELP_TEXT = `NO BULLSHIT RSS CLI v${CLI_VERSION}

Usage:
  no-bullshit-rss stats [--json]
  no-bullshit-rss rss [--rss-url|--amount]
  no-bullshit-rss topics
  no-bullshit-rss lists [--list <name>]
  no-bullshit-rss articles last <count> [--topic <slug>|--no-topic] [--choose] [--url] [--title|--titles]
  no-bullshit-rss articles random [--url] [--title|--titles]
  no-bullshit-rss articles search <count> (--title|--url) <text>
  no-bullshit-rss articles digest <count> [--daily|--weekly|--monthly]

Commands:
  stats                      Show article totals and top 10 feeds and topics
  rss                        Show all stored RSS feeds
  topics                     Show all stored topics
  lists                      Show all stored lists
  lists --list <name>        Show all articles in a named list
  articles last <count>      Show the newest stored articles
  articles random            Show one random stored article
  articles search <count>    Search stored article titles or URLs
  articles digest <count>    Show the newest digest clusters as JSON

Options:
  --json                     Print stats as JSON
  --rss-url                  Print one RSS feed URL per line
  --amount                   Print the number of stored RSS feeds
  --url                      Print one URL per line
  --title, --titles          Print one title per line
  --topic <slug>             Filter newest articles by stored topic slug
  --no-topic                 Show newest articles without an assigned topic
  --choose                   Interactively choose one of the newest articles
  --daily                    Use today's digest (default)
  --weekly                   Use this week's digest
  --monthly                  Use this month's digest
  -v, --version              Show version
  -h, --help                 Show this help

When --url and --title are combined, each line is URL<TAB>TITLE.
Without a projection flag, "articles last" prints a JSON array and "articles random" prints one JSON object.

Examples:
  no-bullshit-rss stats
  no-bullshit-rss stats --json
  no-bullshit-rss rss
  no-bullshit-rss rss --rss-url
  no-bullshit-rss topics
  no-bullshit-rss lists
  no-bullshit-rss lists --list "nvidia"
  no-bullshit-rss articles last 10 --url
  no-bullshit-rss articles last 10 --title
  no-bullshit-rss articles last 10 --url --title
  no-bullshit-rss articles last 10 --choose --url
  no-bullshit-rss articles last 10 --topic ki
  no-bullshit-rss articles last 10 --topic ki --url --title
  no-bullshit-rss articles last 10 --no-topic
  no-bullshit-rss articles random
  no-bullshit-rss articles random --url
  no-bullshit-rss articles search 10 --title "nvidia"
  no-bullshit-rss articles search 10 --url "nvidia"
  no-bullshit-rss articles digest 10 --daily
  no-bullshit-rss articles digest 10 --weekly
  no-bullshit-rss articles digest 10 --monthly`;

export function getHelpText() {
    return HELP_TEXT;
}

function parseCount(value) {
    if (!/^[1-9]\d*$/u.test(String(value || ''))) {
        throw new Error('<count> must be an integer greater than 0.');
    }

    const count = Number(value);
    if (!Number.isSafeInteger(count)) {
        throw new Error('<count> is too large.');
    }
    return count;
}

function rejectUnknownFlags(flags, allowedFlags) {
    const unknown = flags.find(flag => !allowedFlags.has(flag));
    if (unknown) {
        throw new Error(`Unknown option: ${unknown}`);
    }
}

export function parseCliArgs(argv) {
    const args = Array.isArray(argv) ? argv.map(value => String(value)) : [];
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        return { command: 'help' };
    }
    if (args.includes('--version') || args.includes('-v')) {
        return { command: 'version' };
    }

    const [resource, action, countValue, ...flags] = args;
    if (resource === 'stats') {
        rejectUnknownFlags(args.slice(1), new Set(['--json']));
        return { command: 'stats', json: args.includes('--json') };
    }
    if (resource === 'rss') {
        const rssFlags = args.slice(1);
        rejectUnknownFlags(rssFlags, new Set(['--rss-url', '--amount']));
        if (rssFlags.includes('--rss-url') && rssFlags.includes('--amount')) {
            throw new Error('Only one of --rss-url or --amount may be used.');
        }
        return {
            command: 'rss',
            rssUrl: rssFlags.includes('--rss-url'),
            ...(rssFlags.includes('--amount') ? { amount: true } : {}),
        };
    }
    if (resource === 'topics') {
        rejectUnknownFlags(args.slice(1), new Set());
        return { command: 'topics' };
    }
    if (resource === 'lists') {
        const listFlags = args.slice(1);
        if (listFlags.length === 0) return { command: 'lists', listName: null };
        if (listFlags[0] !== '--list') throw new Error(`Unknown option: ${listFlags[0]}`);
        if (!listFlags[1] || !listFlags[1].trim() || listFlags[1].startsWith('--')) {
            throw new Error('Missing required list name after --list.');
        }
        if (listFlags.length > 2) throw new Error(`Unknown option: ${listFlags[2]}`);
        return { command: 'lists', listName: listFlags[1].trim() };
    }
    if (resource !== 'articles') {
        throw new Error(`Unknown resource: ${resource || '(missing)'}`);
    }
    if (!['last', 'random', 'search', 'digest'].includes(action)) {
        throw new Error(`Unknown articles command: ${action || '(missing)'}`);
    }
    if (action === 'random') {
        const randomFlags = args.slice(2);
        rejectUnknownFlags(randomFlags, new Set(['--url', '--title', '--titles']));
        return {
            command: 'articles-random',
            url: randomFlags.includes('--url'),
            title: randomFlags.includes('--title') || randomFlags.includes('--titles'),
        };
    }
    if (countValue === undefined || countValue.startsWith('--')) {
        throw new Error('Missing required <count>.');
    }

    const count = parseCount(countValue);
    if (action === 'last') {
        let topic = null;
        const projectionFlags = [];
        for (let index = 0; index < flags.length; index += 1) {
            const flag = flags[index];
            if (flag !== '--topic') {
                projectionFlags.push(flag);
                continue;
            }
            if (topic !== null) {
                throw new Error('Only one --topic may be used.');
            }
            const topicSlug = flags[index + 1];
            if (!topicSlug || !topicSlug.trim() || topicSlug.startsWith('--')) {
                throw new Error('Missing required topic slug after --topic.');
            }
            topic = topicSlug.trim().toLowerCase();
            index += 1;
        }
        rejectUnknownFlags(projectionFlags, new Set(['--url', '--title', '--titles', '--choose', '--no-topic']));
        const noTopic = projectionFlags.includes('--no-topic');
        if (topic !== null && noTopic) {
            throw new Error('Only one of --topic or --no-topic may be used.');
        }
        return {
            command: 'articles-last',
            count,
            url: projectionFlags.includes('--url'),
            title: projectionFlags.includes('--title') || projectionFlags.includes('--titles'),
            choose: projectionFlags.includes('--choose'),
            topic,
            noTopic,
        };
    }

    if (action === 'search') {
        const fieldFlag = flags[0];
        const searchText = flags[1];
        if (!['--title', '--url'].includes(fieldFlag)) {
            throw new Error('Search requires exactly one of --title or --url.');
        }
        if (!searchText || !searchText.trim() || searchText.startsWith('--')) {
            throw new Error(`Missing search text after ${fieldFlag}.`);
        }
        if (flags.length > 2) throw new Error(`Unknown option: ${flags[2]}`);
        return {
            command: 'articles-search',
            count,
            field: fieldFlag === '--title' ? 'title' : 'url',
            text: searchText.trim(),
        };
    }

    rejectUnknownFlags(flags, new Set(['--daily', '--weekly', '--monthly']));
    const selectedRanges = flags.filter(flag => ['--daily', '--weekly', '--monthly'].includes(flag));
    if (selectedRanges.length > 1) {
        throw new Error('Only one of --daily, --weekly or --monthly may be used.');
    }

    const rangeByFlag = {
        '--daily': 'day',
        '--weekly': 'week',
        '--monthly': 'month',
    };
    return {
        command: 'articles-digest',
        count,
        variant: rangeByFlag[selectedRanges[0]] || 'day',
    };
}
