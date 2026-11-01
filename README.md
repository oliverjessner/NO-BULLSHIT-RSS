<p align="center">
  <img src="public/images/logo/logo.png" alt="NO BULLSHIT RSS logo" width="120" height="120">
</p>

# NO BULLSHIT RSS 💩

[![Dependabot Updates](https://github.com/oliverjessner/NO-BULLSHIT-RSS/actions/workflows/dependabot/dependabot-updates/badge.svg)](https://github.com/oliverjessner/NO-BULLSHIT-RSS/actions/workflows/dependabot/dependabot-updates)

NO BULLSHIT RSS is a free, open-source desktop RSS reader for macOS.
It brings your sources together and helps you find relevant stories in a busy news feed.
Your feeds, saved articles and reading lists stay on your Mac, without subscriptions or ads.

![Compact feed showing articles from multiple sources with search, filters and save controls](public/images/mockups/feed_compact.webp)

Add your RSS feeds in Settings, then browse new articles or catch up through a daily, weekly or monthly digest.
Save useful articles to reading lists and create keyword alerts for subjects you follow closely.

## What it does

- Follow RSS feeds in compact or card layouts.
- Search articles and filter by source, topic or reading list.
- Group related coverage into daily, weekly and monthly digests.
- Explore Golem's most-read and most-commented articles in the separate Most read view.
- Automatically tag articles with your own topic keywords and filter unwanted coverage with bullshit rules.
- Track keyword matches in Watchdog, with optional macOS notifications.
- Save articles to reading lists and dismiss finished articles or stories.
- Import article links and export results as Markdown, JSON, CSV or link lists.
- View library statistics in the app or query stored articles, feeds and digests through the CLI.

## Install

Requires **macOS 13 (Ventura) or newer** on **Apple Silicon (M1 or newer)**.

### Homebrew

```sh
brew install --cask oliverjessner/tap/no-bullshit-rss
```

Homebrew installs the app and the `no-bullshit-rss` command.

### Download

1. Download the `.dmg` from the [latest release](https://github.com/oliverjessner/NO-BULLSHIT-RSS/releases/latest).
2. Open it and drag **NO BULLSHIT RSS** into **Applications**.
3. Launch the app and add your feeds under **Settings → RSS Feeds**.

## CLI

Query stored articles, feeds, topics, reading lists, digests and library statistics from your terminal.

```sh
no-bullshit-rss articles last 10 --url --title
```

After installing the app and adding feeds, this prints the URLs and titles of up to ten of the newest stored articles.
Homebrew makes the command available automatically; DMG users can follow the launcher setup in the guide below.

See the [CLI documentation](docs/cli.md) for all commands and options.

Use `no-bullshit-rss mcp` to read saved articles, digests and Watchdog matches
from an MCP client. See the [MCP setup](docs/mcp.md) for configuration and tools.

## Manage your sources

Add, test, edit and remove RSS feeds under **Settings → RSS Feeds**.
Fetch updates immediately with **fetch now**, or let the app refresh your feeds automatically while it runs.

![RSS feed settings with the add-feed form, test button and list of saved sources](public/images/mockups/settings_rss_feeds.webp)

## Browse and save articles

Switch between a compact headline list and cards with article previews, then narrow the feed with search and filters.
Save articles to reading lists for later and dismiss those you have finished.

![Card layout showing article previews, topic labels and Save and Dismiss controls](public/images/mockups/feed_cards.webp)

## Set your own topics and filters

Define topic keywords to tag matching articles automatically, and apply updated topics to articles already in your library.
Bullshit rules exclude matching articles from Digest; choose **Bullshit: Clean** in Feed to hide them there too.

![Topic settings with keyword fields, saved topics and a control to reclassify existing articles](public/images/mockups/settings_topics.webp)

## Catch up with digests

Choose Day, Week or Month to see related articles grouped into stories across your sources.
Save a story to a reading list or mark it as digested when you are done.

![Monthly digest grouping related articles into stories with source links and save controls](public/images/mockups/digest_month.webp)

## Explore Golem rankings

Open **Most read**, choose **Golem** and select **Refresh** to load its latest most-read and most-commented articles.

If Golem requires access, select **Set up Golem access**, make your cookie or PUR choice in the separate browser window, then return to the app and select **Save access**. **Forget saved access** removes that saved access from the app.

## Follow keyword alerts with Watchdog

Collect keyword matches in a dedicated inbox, with exclusions, feed restrictions and filters for reading state and publication time.
Enable optional macOS alerts under **Settings → Notifications**; watching continues while the app runs, including with its window closed.

![Watchdog inbox with saved keyword rules, article matches, filters and archive controls](public/images/mockups/watchdog.webp)

## Import links and export results

Paste article URLs or load a plain text link list to add articles outside your RSS feeds.
Export Feed, Digest or Watchdog results as Markdown, JSON, CSV or a link list, with active Feed and Watchdog filters preserved.

## Who it is for

- Readers following news sites and blogs through RSS.
- Journalists and researchers tracking keywords across multiple sources.
- People collecting articles for later reading and exporting selected coverage.

## Changelog

See the [changelog](docs/changelog.md) for release notes and changes.

## License

MIT
