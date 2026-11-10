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
- Explore publisher rankings in Most read, mixing all supported media or choosing Golem, WinFuture, ComputerBase, heise iX, t3n, TechCrunch, Ars Technica, WIRED or The Verge.
- Automatically tag articles with your own topic keywords and filter unwanted coverage with bullshit rules.
- Track keyword matches in Watchdog, with optional macOS notifications.
- Save articles to reading lists and dismiss finished articles or stories.
- Import article links and export results as Markdown, JSON, CSV or link lists.
- Explore your library, coverage trends and observed publisher ranking history in Analytics, or query stored articles, feeds and digests through the CLI.

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
Query saved publisher rankings with the same command for most-read, most-commented and editorial selections:

```sh
no-bullshit-rss articles top
no-bullshit-rss articles top 100 --list
no-bullshit-rss articles top --medium t3n --json
no-bullshit-rss articles top 100 --url
no-bullshit-rss articles top --choose
no-bullshit-rss articles top 100 --choose --url
```

`articles top` returns up to 40 unique articles from all supported media by default, newest first. Supply a count for more results and `--medium` to choose a publisher. Choose one output format: `--list` for readable text, `--json` for JSON or `--url` for one URL per line. Add `--choose` to select an article interactively; `--choose --url` prints only the selected URL to stdout, with the chooser on stderr. These commands read saved rankings without fetching new data.

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

## Explore publisher rankings

Open **Most read** and choose **All media** for a combined feed of unique articles from saved publisher rankings, ordered by publication date. The view starts with 40 articles; scroll down or choose **Load more** to continue. Save articles to reading lists or dismiss them using the same cards as Feed.

Choose **Golem**, **WinFuture**, **ComputerBase**, **heise iX**, **t3n**, **TechCrunch**, **Ars Technica**, **WIRED** or **The Verge** to see one publisher's current selection. Available lists include most-read, most-commented and editorial picks, depending on the publisher. See the [Most read compatibility guide](docs/most-read-compatibility.md) for supported media, selection types and access requirements.

Rankings refresh automatically every eight hours while the app runs, with the last attempt remembered across restarts. Choose **Refresh** for an immediate update; saved rankings remain available if an update fails. Regular RSS updates continue independently.

![Most read showing articles from multiple publishers, ranking labels and the medium selector](public/images/mockups/most_read.webp)

## Follow keyword alerts with Watchdog

Collect keyword matches in a dedicated inbox, with exclusions, feed restrictions and filters for reading state and publication time.
Enable optional macOS alerts under **Settings → Notifications**; watching continues while the app runs, including with its window closed.

![Watchdog inbox with saved keyword rules, article matches, filters and archive controls](public/images/mockups/watchdog.webp)

## Explore Analytics

Open **Analytics** for **Overview**, **Trends**, **Publishers**, **Most Read** and **Topics**. Share a period, publisher and topic across tabs, and group charts by day, week or month. The default is the last 30 days; choose 7 days, 90 days or all time. The logo returns to Feed.

Charts use eight distinct series colors and connected observation points. Hover, touch or focus a point to inspect its date, series and value; use the arrow keys to explore observations.

**Overview** shows articles in the selected period, bullshit matches, active feeds, saved articles and ranked articles, with publication volume over time.

![Analytics Overview with five summary cards and an article-volume line chart](public/images/mockups/analytics_overview.webp)

<details>
<summary>Shared filters and chart values</summary>

![Analytics period, publisher, topic and chart-grouping filters](public/images/mockups/analytics_filters.webp)

</details>

**Trends** compares up to eight topics. Topic momentum shows changes against the preceding period, while Emerging topics highlights growth that meets clear minimum-volume thresholds.

![Topic trends with multiple colored series and topic selection controls](public/images/mockups/analytics_trends.webp)

<details>
<summary>Topic momentum and emerging coverage</summary>

![Current and previous topic counts, absolute changes and emerging topics](public/images/mockups/analytics_topic_momentum.webp)

</details>

**Publishers** compares article totals, output per day, bullshit-match rates and ranking coverage. Publisher names open their saved websites. Choose two publishers to compare volume, topics and captured ranking appearances; unsupported ranking types are marked as unavailable.

![Publisher comparison table with website links, article counts and ranking coverage](public/images/mockups/analytics_publishers.webp)

<details>
<summary>Compare two publishers</summary>

![Two publishers compared through publication-volume lines, topic counts and ranking appearances](public/images/mockups/analytics_publisher_comparison.webp)

</details>

**Most Read** summarizes ranked articles, first observations, articles reaching #1, captured snapshots and publishers with data. Sort and page through Top performers, inspect Climbers and Decliners, and explore Longest running, topic performance and publishers with ranking data.

![Most Read analytics summary and sortable Top performers table](public/images/mockups/analytics_most_read.webp)

<details>
<summary>Ranking history, movement and coverage</summary>

Choose **History** to open an article's ranking charts in a dialog. Five cards show its best and latest observed rank, first and last appearance, and observed span. Rank 1 stays at the top; absences from captured snapshots break the line. The observed span can include gaps.

![Ranking history dialog with five metrics and separate charts for each ranking type](public/images/mockups/analytics_ranking_history.webp)

![Climbers and Decliners comparing actual consecutive ranking snapshots](public/images/mockups/analytics_ranking_movement.webp)

![Longest-running articles, topic performance and publishers with stored ranking data](public/images/mockups/analytics_ranking_details.webp)

</details>

**Topics** lets you select a topic to inspect matching articles, coverage over time, momentum, co-occurring topics and ranking appearances. An article can belong to several topics.

![Topic analytics with article counts and coverage over time](public/images/mockups/analytics_topics.webp)

<details>
<summary>Inspect a topic</summary>

![Selected-topic metrics, momentum, co-occurrence and ranking appearances](public/images/mockups/analytics_topic_details.webp)

</details>

Open matched articles in the shared article viewer, follow the original link or save an article to a reading list.

<details>
<summary>Read and save from Analytics</summary>

![Analytics article viewer beside the ranking table](public/images/mockups/analytics_article_viewer.webp)

![Save dialog for adding a ranked article to a reading list](public/images/mockups/analytics_save_article.webp)

</details>

Analytics reads your stored library. Ranking positions are not pageview counts or direct audience measurements; editorial Top-News remain separate from most-read and most-commented lists.

See the [Analytics guide](docs/analytics.md) for metric definitions, comparison methods and data limitations.

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
