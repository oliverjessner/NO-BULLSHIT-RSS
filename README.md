# NO BULLSHIT RSS 💩

I vibe coded some electron slop.

![NO BULLSHIT RSS compact feed](public/images/mockups/feed_compact_1920.webp)

NO BULLSHIT RSS is a minimal, open-source desktop RSS reader that focuses on reading—not dashboards, upsells, or noise. It has no payments, subscriptions, or ads and stores feeds and articles locally in SQLite.

## Highlights

- Local SQLite database: your feeds and articles stay on your machine
- Open source with no payments, subscriptions, or ads
- Daily Digest: a clustered view that groups related articles for faster scanning
- Local Topics: rule-based topic tagging (no external API) with editable JSON rules
- Improved clustering: fuzzier matching with stronger logic and guardrails
- Instant search: highlight a word, right-click, and search it immediately
- Dark-only interface
- Storage visibility: settings now show how many articles are in your database

## Frontend

Shared design tokens and UI primitives come from the
[PineFetch Designsystem](https://github.com/oliverjessner/PineFetch-Designsystem)
package. App-specific layout and responsive behavior remain in `public/styles.css`.

## Digest

Related articles from multiple sources are clustered into daily, weekly, and monthly stories.

![NO BULLSHIT RSS monthly digest](public/images/mockups/digest_month_1920.webp)

## Settings

<details>
<summary>RSS feed management</summary>
<br>

![NO BULLSHIT RSS feed settings](public/images/mockups/settings_rss_feeds_1920.webp)

</details>

<details>
<summary>Local topic rules</summary>
<br>

![NO BULLSHIT RSS topic settings](public/images/mockups/settings_topics_1920.webp)

</details>

Also check out the [landing page](https://oliverjessner.at/no-bullshit-rss/#promise).

## Run locally

Install the dependencies and start the Electron app:

```bash
npm install
npm run dev
```

To run only the local web server, use `npm start`.

## CLI

The CLI only reads data already stored by NO BULLSHIT RSS. It does not fetch or configure RSS feeds.

The macOS DMG includes a self-contained CLI launcher. After installing the app, link it once to make `no-bullshit-rss` available in the terminal; no separate Node.js installation is required.

See the [CLI documentation](docs/cli.md) for setup, commands, output formats, and database discovery.

## Platform support

Prebuilt releases currently support macOS on Apple Silicon (M1 or newer) only. Intel Macs, Windows, and Linux are not release targets.

## Build and publish

Build the macOS ARM64 DMG:

```bash
npm run dist:mac
```

The artifact is written to `electron/dist`. Check the resolved release without making changes:

```bash
npm run publish -- --dry-run
```

Create the release:

```bash
npm run publish
```

> [!IMPORTANT]
> Publishing stages and commits pending changes, pushes the current branch, builds the DMG, creates and pushes the version tag, and creates the GitHub release.
