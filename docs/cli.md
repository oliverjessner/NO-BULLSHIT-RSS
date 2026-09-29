# NO BULLSHIT RSS CLI

The `no-bullshit-rss` CLI reads data already stored by NO BULLSHIT RSS. It does not fetch or configure RSS feeds, start Express, run migrations, or write to the database. SQLite is opened in read-only mode.

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

## Database discovery

The CLI resolves the existing database in this order:

1. An existing file specified by `DB_PATH`.
2. `data-v2.db` in the current NO-BULLSHIT-RSS repository.
3. The installed Electron app's `NO-BULLSHIT-RSS/data-v2.db` user-data directory on macOS, Windows, or Linux.

If no existing database is found, the CLI exits with an error. It never creates an empty database.

## Shell usage

Successful results are written to stdout. Errors are written to stderr, so piping and redirection remain clean:

```bash
no-bullshit-rss articles last 10 --url --title | grep Nvidia
no-bullshit-rss articles last 10 --url > urls.txt
```
