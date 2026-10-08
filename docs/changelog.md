# 1.1.3

- automatic screenshots

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
