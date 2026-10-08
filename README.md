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
[oj-designsystem](https://github.com/oliverjessner/oj-designsystem)
package, pinned to version 0.1.0. It supplies Comfortaa for the interface,
JetBrains Mono for technical data, local Font Awesome icons, form controls,
panels, tags, keyboard-accessible settings tabs and action menus, native dialogs,
and stacked notifications with app-owned Undo actions. Fonts, icons, CSS and
browser modules are served locally from `/vendor/oj-designsystem/`; no CDN or
frontend build step is required. The product accent is set with `--oj-accent`;
app-specific layout and responsive behavior remain in `public/styles.css`.

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

## Generate screenshots

With the Electron app or local web server running, generate the four README screenshots from its existing local data:

```bash
npm run mockups:install # Install Chromium once after npm install
npm run mockups
```

The script deletes and recreates `public/images/mockups/` before capturing the compact feed, monthly digest, RSS feed settings, and topic settings. Each image is a 1920 × 1080 WebP with the existing README filename. It uses a separate browser session and waits for the views, fonts, and images to load.

For a different local server address, use `npm run mockups -- --url http://127.0.0.1:1378`.

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
