import { queryArticles } from '../backend/services/article-queries.js';
import { readStoredDigestPayload } from '../backend/services/digest-reader.js';
import { readStatistics } from '../backend/services/statistics-reader.js';
import { readPublisherRankingsPayload } from '../backend/services/publisher-rankings-reader.js';
import { CLI_VERSION, parseCliArgs, getHelpText } from './lib/arguments.js';
import { chooseArticle as chooseArticleInteractively } from './lib/choose.js';
import { discoverDatabasePath } from './lib/database-path.js';
import { readStoredFeeds } from './lib/feeds.js';
import { readRandomStoredArticle, readStoredListArticles, readStoredLists, readStoredTopics } from './lib/library.js';
import { formatChosenArticle, formatDigest, formatFeeds, formatLastArticles, formatStatistics, formatPublisherRankings } from './lib/output.js';
import { openReadOnlyDatabase } from './lib/read-only-database.js';
import { writeWatchdog } from './lib/watchdog-api.js';
import { readStoredWatchdogs, readStoredWatchdog, readStoredWatchdogMatches,
    readStoredWatchdogMatch, readWatchdogNotificationSettings } from '../backend/services/watchdog-reader.js';

function writeLine(stream, value) {
    stream.write(`${value}\n`);
}

function writeResult(stream, value) {
    if (!value) {
        return;
    }
    writeLine(stream, value);
}

export async function runCli(
    argv,
    {
        stdout = process.stdout,
        stderr = process.stderr,
        stdin = process.stdin,
        cwd = process.cwd(),
        env = process.env,
        platform = process.platform,
        homeDir,
        discoverDatabase = discoverDatabasePath,
        openDatabase = openReadOnlyDatabase,
        chooseArticle = chooseArticleInteractively,
        fetchApi = fetch,
    } = {},
) {
    let database;
    let exitCode = 0;
    try {
        const command = parseCliArgs(argv);
        if (command.command === 'help') {
            writeLine(stdout, getHelpText());
            return exitCode;
        }
        if (command.command === 'version') {
            writeLine(stdout, CLI_VERSION);
            return exitCode;
        }

        if (command.command === 'watchdog-write') {
            writeResult(stdout, JSON.stringify(await writeWatchdog(command, { env, fetchApi }), null, 2));
            return exitCode;
        }

        const databasePath = await discoverDatabase({ cwd, env, platform, homeDir });
        database = await openDatabase(databasePath);
        const schema = await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'digest_periods'");
        if (!schema) throw new Error('Database schema v2 is required; use data-v2.db or restore the legacy archive separately.');
        const feedColumns = await database.all('PRAGMA table_info(feeds)');
        database.feedNamesAvailable = feedColumns.some(column => column.name === 'name');
        database.bullshitRulesAvailable = Boolean(await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'article_bullshit_matches'"));

        if (command.command.startsWith('watchdog-')) {
            if (!await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watchdogs'")) {
                throw new Error('Watchdog schema is missing. Open the updated app to migrate this database.');
            }
            let result;
            if (command.command === 'watchdog-list') result = await readStoredWatchdogs(database);
            if (command.command === 'watchdog-show') result = await readStoredWatchdog(database, command.id);
            if (command.command === 'watchdog-match') result = await readStoredWatchdogMatch(database, command.id);
            if (command.command === 'watchdog-matches') result = await readStoredWatchdogMatches(database, command);
            if (command.command === 'watchdog-notifications') result = await readWatchdogNotificationSettings(database);
            if (result === null) throw new Error('Watchdog or match not found.');
            writeResult(stdout, JSON.stringify(result, null, 2));
        } else if (command.command === 'publisher-rankings') {
            const payload = await readPublisherRankingsPayload(command.medium, database);
            writeResult(stdout, formatPublisherRankings(payload, command));
        } else if (command.command === 'stats') {
            writeResult(stdout, formatStatistics(await readStatistics(database), command));
        } else if (command.command === 'rss') {
            const feeds = await readStoredFeeds(database);
            writeResult(stdout, formatFeeds(feeds, command));
        } else if (command.command === 'topics') {
            writeResult(stdout, JSON.stringify(await readStoredTopics(database), null, 2));
        } else if (command.command === 'lists' && command.listName) {
            writeResult(stdout, formatLastArticles(await readStoredListArticles(database, command.listName)));
        } else if (command.command === 'lists') {
            writeResult(stdout, JSON.stringify(await readStoredLists(database), null, 2));
        } else if (command.command === 'articles-search') {
            const articles = await queryArticles(
                {
                    limit: command.count,
                    offset: 0,
                    activeOnly: false,
                    includeTopics: false,
                    maxLimit: null,
                    titleContains: command.field === 'title' ? command.text : null,
                    urlContains: command.field === 'url' ? command.text : null,
                },
                database,
            );
            writeResult(stdout, formatLastArticles(articles));
        } else if (command.command === 'articles-random') {
            const article = await readRandomStoredArticle(database);
            if (!article) throw new Error('No stored articles found.');
            writeResult(stdout, formatChosenArticle(article, command));
        } else if (command.command === 'articles-last') {
            const articles = await queryArticles(
                {
                    topic: command.topic,
                    noTopic: command.noTopic,
                    limit: command.count,
                    offset: 0,
                    activeOnly: false,
                    includeTopics: false,
                    maxLimit: null,
                },
                database,
            );
            if (command.choose) {
                const selectedArticle = await chooseArticle(articles, { input: stdin, output: stderr });
                writeResult(stdout, formatChosenArticle(selectedArticle, command));
            } else {
                writeResult(stdout, formatLastArticles(articles, command));
            }
        } else if (command.command === 'articles-digest') {
            const payload = await readStoredDigestPayload(command.variant, database);
            writeResult(stdout, formatDigest(payload, command.count));
        }
    } catch (error) {
        writeLine(stderr, `Error: ${error?.message || String(error)}`);
        exitCode = 1;
    } finally {
        if (database) {
            try {
                await database.close();
            } catch (error) {
                writeLine(stderr, `Error closing database: ${error?.message || String(error)}`);
                exitCode = 1;
            }
        }
    }
    return exitCode;
}
