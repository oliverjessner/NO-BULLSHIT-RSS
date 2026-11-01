# 1.7.0

- Read saved publisher rankings through `--most-read <medium>` and `--most-commented <medium>`, with RSS article data and optional JSON output.
- Refresh all publisher rankings on a separate eight-hour schedule, remember attempts across restarts, and match newly fetched RSS articles without another publisher capture.
- Add WinFuture's most-read and most-commented rankings with publisher selection, saved ranking history and RSS matching.
- Update Tauri's opener to 2.7.2 (Dependabot #14).
- Update the cc build dependency to 1.10.0 (Dependabot #21).
- Keep Compact feed rows at their content height when scrolling or switching layouts.
- Share RSS decoding and validation across Settings and scheduled imports and report publisher access blocks such as VentureBeat's HTTP 429.
- Seed the 40 production RSS feeds on new or incomplete installations while preserving existing preferences and later deletions.
- Include the 13 production Bullshit rules for new installations and add missing defaults without changing existing rule preferences.
- Clean saved and displayed feed, website and article URLs with Linkary, removing tracking parameters and fragments while retaining functional query parameters and recognizing legacy import URLs.
- Deliver Watchdog notifications through macOS UserNotifications with foreground banners, delivery errors, tap routing and permission recovery in Settings.
- Show Golem's most-read and most-commented articles in a dedicated Most read view with Golem selection, independent refresh, ranking history and RSS matching.
- Keep publisher rankings visible while loading or after failed updates, report refresh status, and fall back to installed Chrome when available.
- Keep Golem access automatic through Fetchary's consent acceptance without manual login, session setup or PUR controls.
- Use Fetchary's accept consent policy for Golem and handle its cookie choice automatically during browser capture.
- Render publisher rankings with the Feed's article cards, RSS titles and previews, reading-list actions and dismiss/Undo controls, without repeated access or refresh explanations.

# 1.6.0

- icons for menu buttons
- Show the number of saved RSS feeds in Settings and through `rss --amount`, excluding imported-link sources.
- Add Watchdog CLI commands to read and filter rules and matches, create, update and delete rules, change read/archive state, and manage notification preferences through the running app.
- Add `no-bullshit-rss mcp` with 15 read-only tools for saved articles, feeds, digests, statistics, topics, lists and Watchdogs.
- Isolate read queries from the app's writable database connection so CLI reads and MCP access remain read-only.
- Configure weekly Dependabot updates for npm and Cargo dependencies.
- Backport the GLib `VariantStrIter` security fix (GHSA-wrw7-89jp-8q8g) while retaining compatibility with Tauri's GTK3 dependencies.

# 1.5.0

- Add Watchdog: create, edit, pause and delete individual keyword rules with include-any, include-all, exclusions and optional feed restrictions.
- Keep an idempotent local match inbox with historical lookup, read/archive state, filters, unread badges and SSE updates.
- Add opt-in native macOS notifications through the Node/Tauri bridge, grouped per watchdog with click-through to the matching article, including when the main window is closed.
- Keep historical matches and first feed imports silent, isolate notification errors from RSS fetching, and serialize SQLite access across concurrent API and scheduler transactions.
- Fix Watchdog notification permission calls from Tauri's local development origin, retain native error messages, and explain when notifications require the bundled macOS app.
- Keep Watchdog filters and selection in place while scrolling the article inbox independently, including keyboard scrolling.
- Move Watchdog notification preferences to Settings → Notifications; add Feed-compatible Markdown/JSON/CSV/link exports, publication-time filters, and full-card mouse/keyboard activation.
- Preserve loaded Watchdog pages, pagination cursors and scroll position when changing read/archive state or receiving live updates; add articles to lists through the existing list dialog.
- Rename the Settings feed tab to RSS Feeds.
- Include the Watchdog view in the regular six-image screenshot generation and README.
- Fix feed logo discovery with Fetchary 2.0.4 for redirected webpages, manifests and icons while preserving download size limits and timeouts.

# 1.4.0

- Filter the newest CLI articles by topic with `articles last <count> --topic <slug>`.
- Show articles without an assigned topic using `--no-topic` in the CLI or **Topic: None** in the UI.
- Apply CLI topic filters before the result limit and combine them with `--url`, `--title`, and `--choose`.
- Keep the no-topic filter when loading more articles and exporting the feed, including filter metadata in JSON and Markdown.

# 1.3.3

- new logo

# 1.3.2

- move https://github.com/oliverjessner/fetchary/ to extract the favicon
- small cosmetics in the settings
- click on the bullshit logo to see the stats

# 1.3.0

- tauri

# 1.1.4

- smaller ui fixes
- automatic screenshots
- publish the Homebrew cask and bundled CLI with each release

# 1.1.2

- moving to https://github.com/oliverjessner/oj-designsystem

# 1.1.1

- update all deps
- addding --version as flag and showing the version in --help
- move to pinefetch design system
- removed the light mode
- publish macOS Apple Silicon builds only
- cleaning up all stuff

# 1.1.0

- Export feed with active search criteria and export digest
- Bullshit filter
- import button

# 1.0.2

- search in cli `no-bullshit-rss articles search 10 --title "nvidia"`
- random in cli `no-bullshit-rss articles random`
- security issues fixed with [ItWorksBut](https://github.com/oliverjessner/ItWorksBut)

# 1.0.1

- improvements on the cli adding rss, topics, lists
- bug fixes

# 1.0.0

- UX overhaul
- Adding CLI
- Topic improvement
- complete Database overhaul
- updated many deps
- improve CSS, JS, backend perf

# 0.5.1

- fixed vibe coding problems with https://github.com/oliverjessner/ItWorksBut

# 0.5.0

- ui overhaul, more hierarchy depth

# 0.4.0

Features:

- in-app viewer (browser) for the articles

# 0.3.0

Features:

- Daily Digest for week and month

Minor Fixes

- Quality managament for all parts of the app
- aria labels
- sorted, cleaned up, millionen of ai slop lines
- focus management in modal
- massive perf improvement on large databases
- SQLite clean up

# 0.2.0

Features:

- Topics: define your own topics and let NO-BULLSHIT-RSS classify matching articles automatically.
- Filter articles by topic in the Dashboard.
- Lists can now be deleted.
- Daily Digest now supports adding articles to lists.
- Added a clear button in the Dashboard (also available via `Esc`).
- Daily Digest now supports blocked words and excluded sources.

Minor fixes:

- Removed the remaining German text from a modal.
- Improved button styling for clearer destructive/save actions.

# 0.1.0

Features:

- Daily Digest: a dedicated view that clusters related articles.
- Daily Digest clustering is now fuzzier, with stronger matching logic and guardrails.
- Highlight any text, right-click, and search for it instantly.
- Added dark mode.
- Settings now show how many articles are stored in the database.

Minor fixes:

- Switched UI text to English and improved naming consistency (dark mode contrast still needs accessibility improvements).
- Multiple UX/UI improvements.
- Removed legacy low-quality code paths.
- Added hover animations.
- Added a "Buy me a coffee" button in the About window.
- Refactored smaller code areas for better maintainability.
- Updated outdated dependencies.

ToDo:

- Verify Windows compatibility with real-world user feedback.
- Add an automated test suite.
- Collect broader test feedback beyond local development.
