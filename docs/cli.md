# NO BULLSHIT RSS CLI

The `no-bullshit-rss` CLI reads data already stored by NO BULLSHIT RSS through a read-only SQLite connection. Watchdog management commands send explicit changes to the running app's local API. The CLI never starts the server, runs migrations, or fetches RSS feeds.

## DMG installation

The macOS DMG includes the CLI and its runtime inside the app bundle. After dragging `NO BULLSHIT RSS.app` to Applications, link the bundled launcher once:

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sfn "/Applications/NO BULLSHIT RSS.app/Contents/Resources/bin/no-bullshit-rss" /usr/local/bin/no-bullshit-rss
```

The command is then available in a new terminal without installing Node.js or running `npm link`:

```bash
no-bullshit-rss --help
no-bullshit-rss --version
```

## Development setup

Run the CLI directly from the repository or create a local npm link:

```bash
node ./cli/no-bullshit-rss.js --help
npm link
```

After `npm link`, the `no-bullshit-rss` command is available in your shell.

## Statistics

Show the same library statistics as the app's logo dialog:

```bash
no-bullshit-rss stats
```

This prints the total article count, the top 10 feeds and topics by article count,
and the number of distinct articles matched by bullshit rules. Counts include
all stored articles, including dismissed articles. Each bullshit article is counted once.

For scripts, return the same data as JSON:

```bash
no-bullshit-rss stats --json
```

## Publisher rankings

Read the latest saved Golem, WinFuture, ComputerBase, heise iX or t3n publisher selections, independently of the Digest period:

```bash
no-bullshit-rss --most-read golem
no-bullshit-rss --most-commented golem
no-bullshit-rss --most-read golem --json
no-bullshit-rss --most-read winfuture
no-bullshit-rss --most-commented winfuture --json
no-bullshit-rss --most-read computerbase
no-bullshit-rss --most-read computerbase --json
no-bullshit-rss --top-news heise-ix
no-bullshit-rss --top-news heise-ix --json
no-bullshit-rss --most-read t3n
no-bullshit-rss --most-read t3n --json
```

Text output contains publisher, capture time and ranked titles with URLs. JSON also includes the matched RSS article data when available. These commands read the existing database without fetching or changing anything; use Refresh in the app to capture new rankings. The help lists supported media when an invalid medium is supplied.

The ComputerBase integration supports most-read news from the last 72 hours. Most-commented rankings are not supported for ComputerBase; `--most-commented computerbase` reports this and suggests `--most-read computerbase`.

heise iX supports editorial **Top-News**, stored separately from most-read and most-commented rankings. Use `--top-news heise-ix`; unsupported flags such as `--most-read heise-ix` report the supported command before opening the database.

t3n supports **most-read** articles. Use `--most-read t3n`; `--most-commented t3n` and `--top-news t3n` report that those selections are unsupported and suggest the most-read command before opening the database.

## Latest articles

Print one URL per line:

```bash
no-bullshit-rss articles last 10 --url
```

Print one title per line. `--titles` is an alias for `--title`:

```bash
no-bullshit-rss articles last 10 --title
no-bullshit-rss articles last 10 --titles
```

Print the URL and title separated by a tab:

```bash
no-bullshit-rss articles last 10 --url --title
```

Without a projection flag, the command returns compact JSON:

```bash
no-bullshit-rss articles last 10
```

Interactively choose one of the newest articles with the arrow keys or `j`/`k`, then confirm with Enter:

```bash
no-bullshit-rss articles last 10 --choose --url
no-bullshit-rss articles last 10 --choose --title
no-bullshit-rss articles last 10 --choose --url --title
```

The selector is rendered on stderr and only the selected result is written to stdout. `Esc`, `q`, or `Ctrl+C` cancels the selection. Without `--url` or `--title`, the selected article is returned as one compact JSON object.

Articles are ordered by `publishedAt DESC, id DESC`.

Filter the newest articles by an assigned topic:

```bash
no-bullshit-rss articles last 10 --topic ki
no-bullshit-rss articles last 10 --topic ki --url --title
no-bullshit-rss articles last 10 --topic ki --choose --url
```

Use the topic's `slug` from `no-bullshit-rss topics`. Matching ignores case and
surrounding whitespace. The filter is applied before the result count, so this
returns up to 10 of the newest articles assigned to `ki`. An unknown topic or a
topic without assigned articles returns an empty result. The filter uses stored
topic assignments and does not reclassify articles.

Show the newest articles without any assigned topic:

```bash
no-bullshit-rss articles last 10 --no-topic
no-bullshit-rss articles last 10 --no-topic --url --title
no-bullshit-rss articles last 10 --no-topic --choose --url
```

Like `--topic`, this filter is applied before the result count. `--topic` and
`--no-topic` cannot be combined. In the app, choose **Topic: None** in the topic
filter to show articles without an assigned topic.

## Random article

Return one randomly selected stored article as a compact JSON object:

```bash
no-bullshit-rss articles random
```

The existing projection flags can be used to print only the URL, title, or both:

```bash
no-bullshit-rss articles random --url
no-bullshit-rss articles random --title
no-bullshit-rss articles random --url --title
```

## Search articles

Search the newest stored articles whose title contains text. Matching is case-insensitive:

```bash
no-bullshit-rss articles search 10 --title "nvidia"
```

Search the newest stored articles whose URL contains text:

```bash
no-bullshit-rss articles search 10 --url "nvidia"
```

The number is the maximum result count. Results use the same compact JSON format and ordering as `articles last`.

## Stored RSS feeds

Return all stored feeds with their names, feed URLs, and website URLs as JSON:

```bash
no-bullshit-rss rss
```

Print only the RSS feed URLs, one per line:

```bash
no-bullshit-rss rss --rss-url
```

Show the number of stored RSS feeds (also visible in **Settings → RSS Feeds**):

```bash
no-bullshit-rss rss --amount
```

This prints a plain integer, including `0` for an empty library. Imported-link
sources are excluded, just as in the settings feed list. `--amount` and
`--rss-url` cannot be combined.

## Topics and lists

Return all stored topic definitions:

```bash
no-bullshit-rss topics
```

Return all lists, including the number of stored articles in each list:

```bash
no-bullshit-rss lists
```

Return all articles from a list. List-name matching is case-insensitive:

```bash
no-bullshit-rss lists --list "nvidia"
```

## Digests

Digest commands reuse the same date ranges, filtering, and clustering as the app:

```bash
no-bullshit-rss articles digest 10 --daily
no-bullshit-rss articles digest 10 --weekly
no-bullshit-rss articles digest 10 --monthly
```

If no range is provided, the daily digest is used. The result is a JSON array containing up to the requested number of story clusters.

## Watchdog

Read rules, a single rule, stored matches, a single match or notification settings:

```bash
no-bullshit-rss watchdog
no-bullshit-rss watchdog show 1
no-bullshit-rss watchdog matches --watchdog 1 --status unread --range 7d --limit 50
no-bullshit-rss watchdog matches --archived
no-bullshit-rss watchdog match 42
no-bullshit-rss watchdog notifications
```

`watchdogs` is an alias for `watchdog`. All results are JSON. Matches default to
the unarchived inbox, all read states and all dates, newest match ID first.
`--archived` selects archived matches instead. Ranges are `24h`, `7d`, `month`,
`year` and `all`, using the app's date filters. `--limit` accepts 1–250 (default 50).
When `hasMore` is true, pass the last returned match ID as `--before` for the
next page. Keep the same `--as-of <Unix milliseconds>` when paging a time range.
Reading never marks a match read, archives it, sends notifications, or runs a
Watchdog scan. A database without Watchdog tables requires the app's migration.

Manage Watchdogs through the running app:

```bash
no-bullshit-rss watchdog create --data '{"name":"GPU news","includeAny":["Nvidia","AMD"],"includeHistory":false}'
no-bullshit-rss watchdog update 1 --data '{"enabled":false}'
no-bullshit-rss watchdog update 1 --data '{"includeAll":["GPU"],"exclude":["sponsored"],"feedIds":[2,3]}'
no-bullshit-rss watchdog set-match 42 --data '{"read":true}'
no-bullshit-rss watchdog set-match 42 --data '{"archived":true}'
no-bullshit-rss watchdog notifications on
no-bullshit-rss watchdog notifications off
no-bullshit-rss watchdog delete 1
```

The API validates the same rule fields as the app. Creating with
`includeHistory: true` explicitly scans existing articles; editing or enabling a
rule affects future articles. Deleting a rule deletes its matches as in the app.
`set-match` accepts `read` and/or `archived` booleans, including `false` to undo
the state. The API defaults to `http://127.0.0.1:1377`; set `NBS_API_URL` to the
running instance's loopback origin if it uses another port. For example:

```bash
NBS_API_URL=http://127.0.0.1:1499 no-bullshit-rss watchdog update 1 --data '{"enabled":true}'
```

Writes target that running instance, while reads use `DB_PATH` or discovery.
When using several instances, configure both explicitly for the same library.

## Read-only MCP

Run `no-bullshit-rss mcp` from an MCP client's stdio server configuration to
expose the reading commands as tools. Watchdog management commands are excluded.
See [MCP setup and tools](mcp.md).

## Database discovery

The CLI resolves the existing database in this order:

1. An existing file specified by `DB_PATH`.
2. `data-v2.db` in the current NO-BULLSHIT-RSS repository.
3. The installed desktop app's `NO-BULLSHIT-RSS/data-v2.db` user-data directory on macOS, Windows, or Linux. The Tauri app preserves the directory used by Electron.

If no existing database is found, the CLI exits with an error. It never creates an empty database.

## Shell usage

Successful results are written to stdout. Errors are written to stderr, so piping and redirection remain clean:

```bash
no-bullshit-rss articles last 10 --url --title | grep Nvidia
no-bullshit-rss articles last 10 --url > urls.txt
```
