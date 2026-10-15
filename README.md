# NO BULLSHIT RSS 💩

A free, open-source desktop RSS reader. Follow your sources, find relevant stories,
and keep your feeds and articles on your machine. No subscriptions or ads.

![NO BULLSHIT RSS compact feed](public/images/mockups/feed_compact.webp)

## Features

- **Compact and card layouts:** choose how you browse your articles in a dark interface.
- **Daily, weekly, and monthly digests:** group related articles from multiple sources into stories.
- **Local topics:** automatically tag articles with your own keyword rules.
- **Search and filters:** find articles by text, source, topic, or reading list. Select a word and search it from the context menu.
- **Bullshit rules:** exclude matching articles and selected RSS feeds from digests. Use the Clean filter to hide matching articles in Feed.
- **Reading lists:** save articles for later and dismiss stories you have finished.
- **Import and export:** add article URLs directly or from a text file; export feeds and digests as TXT, CSV, or JSON.
- **Website icons:** recognize your sources at a glance with automatically fetched icons.
- **Library statistics:** click the app logo or run `no-bullshit-rss stats` for article totals, top feeds and topics, and detected bullshit articles.
- **CLI:** access stored articles, feeds, lists, topics, and digests from your terminal. [See commands](docs/cli.md).

## Install

Requires **macOS 13 (Ventura) or newer** on **Apple Silicon (M1 or newer)**.

### Homebrew

```bash
brew install --cask oliverjessner/tap/no-bullshit-rss
```

This installs the app and the `no-bullshit-rss` command.

### Download

1. Download the `.dmg` from the [latest release](https://github.com/oliverjessner/NO-BULLSHIT-RSS/releases/latest).
2. Open it and drag **NO BULLSHIT RSS** into **Applications**.
3. Launch the app and add your RSS feeds in **Settings**.

## Screenshots

<details>
<summary>Monthly digest</summary>
<br>

![NO BULLSHIT RSS monthly digest](public/images/mockups/digest_month.webp)

</details>

<details>
<summary>RSS feed management</summary>
<br>

![NO BULLSHIT RSS feed settings](public/images/mockups/settings_rss_feeds.webp)

</details>

<details>
<summary>Local topic rules</summary>
<br>

![NO BULLSHIT RSS topic settings](public/images/mockups/settings_topics.webp)

</details>
