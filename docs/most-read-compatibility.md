# Most read compatibility

The **Most read** menu collects publisher selections. Their original names remain visible because most-read charts, most-commented charts and editorial selections describe different things.

| Medium (`--medium`) | Supported selections | Publisher source | RSS feed |
| --- | --- | --- | --- |
| Golem (`golem`) | Most read; Most commented | [Golem homepage](https://www.golem.de/) | [RSS](https://rss.golem.de/rss.php?feed=RSS2.0) |
| WinFuture (`winfuture`) | Most read; Most commented | [WinFuture homepage](https://winfuture.de/) | [RSS](https://static.winfuture.de/feeds/WinFuture-News-rss2.0.xml) |
| ComputerBase (`computerbase`) | Most read: news from the last 72 hours | [ComputerBase homepage](https://www.computerbase.de/) | [RSS](https://www.computerbase.de/rss/news.xml) |
| heise iX (`heise-ix`) | Top-News | [iX homepage](https://www.heise.de/ix/) | [RSS](https://www.heise.de/ix/feed.xml) |
| t3n (`t3n`) | Most read | [t3n homepage](https://t3n.de/) | [RSS](https://t3n.de/rss.xml) |
| TechCrunch (`techcrunch`) | Top Headlines | [TechCrunch homepage](https://techcrunch.com/) | [RSS](https://techcrunch.com/feed/) |
| Ars Technica (`arstechnica`) | Most read | [Ars Technica homepage](https://arstechnica.com/) | [RSS](https://feeds.arstechnica.com/arstechnica/index) |

## Browsing collected articles

Choose **All media** for a combined feed. It starts with 40 articles and loads another page as you scroll; **Load more** also supports keyboard navigation.

The combined feed and the CLI collect distinct article URLs from saved ranking history, including all supported selection types. Articles are ordered by RSS publication time, falling back to their capture time when RSS metadata is unavailable. A URL appears once, with its selection names and publisher attached. Individual medium views show the latest saved selection of each supported type.

Each set of pages uses a fixed ranking-history watermark. Refresh and live updates can start a new window while preserving the loaded page depth and the article in view. Current dismissal and Bullshit filters continue to apply.

## RSS matching and access

Ranked URLs are matched to articles from the corresponding stored RSS source. Matched cards use the RSS title, preview, topics and reading-list state, with the usual viewer, Save and Dismiss actions. Entries awaiting an RSS match retain their publisher title and external link; Save and Dismiss become available after a matching article is fetched.

At least one RSS feed for the medium must be configured. heise iX additionally requires an iX website path and its `/ix/feed.xml` feed, keeping it separate from heise online and c’t. Renaming a source does not change its publisher identity.

Capture starts with an HTTP request and validates the actual selection before saving it. A missing selection can trigger browser rendering. Fetchary accepts cookie consent automatically; browser fallback requires a complete Chrome installation available through the app's packaged browser, installed Google Chrome, a configured `PUPPETEER_EXECUTABLE_PATH`, or Puppeteer's managed browser.

t3n loads its list with UpScore JavaScript and currently needs browser rendering. WinFuture supports both its 24-hour popular sidebar and its current public “Meistgelesene” tab. TechCrunch's RSS feed supplies article data; its homepage supplies the Top Headlines selection.

## Updates and saved data

All configured media refresh every eight hours while the app runs. The last all-media attempt is remembered across restarts. **Refresh** captures immediately; a refresh of one medium leaves the all-media schedule intact. Regular RSS fetching updates article associations independently.

A failed or incomplete capture keeps the last successful saved selection. The application does not replace an unavailable publisher chart with unrelated recent RSS articles. Publisher markup, consent systems and access restrictions can change, so a previously working source may require an adapter update.

## CLI

```sh
no-bullshit-rss articles top
no-bullshit-rss articles top 100
no-bullshit-rss articles top --medium t3n
no-bullshit-rss articles top 100 --json
no-bullshit-rss articles top --list
no-bullshit-rss articles top --choose
```

The default is 40 articles across all media. `--medium` selects a publisher; all its supported selection types are included. `--list` requests readable text, `--json` returns structured article data, and `--choose` opens the interactive article selector. These commands read the existing database without fetching or changing data.

See the [CLI guide](cli.md) for options and examples.
