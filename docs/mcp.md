# Read-only MCP server

Use the stored RSS library from an MCP client over stdio:

```bash
no-bullshit-rss mcp
```

The client launches this command and exchanges newline-delimited JSON-RPC
messages on stdin/stdout. It is not an HTTP server. It implements MCP protocol
versions `2025-06-18`, `2025-03-26` and `2024-11-05`, with initialization, ping,
tool discovery and tool calls. Close stdin to end the session.

Configure your client's stdio server entry (replace the database path with your
existing library):

```json
{
  "mcpServers": {
    "no-bullshit-rss": {
      "command": "/usr/local/bin/no-bullshit-rss",
      "args": ["mcp"],
      "env": {
        "DB_PATH": "/Users/YOUR_USER/Library/Application Support/NO-BULLSHIT-RSS/data-v2.db"
      }
    }
  }
}
```

For a repository checkout, use the absolute path to your Node 26+ executable as
`command` and `["/absolute/path/NO-BULLSHIT-RSS/cli/no-bullshit-rss.js", "mcp"]`
as `args`. The bundled desktop CLI also supports `mcp` after rebuilding the app.
Without `DB_PATH`, the same database discovery rules as the CLI apply.

| Tools | Stored data |
| --- | --- |
| `get_feed`, `search_articles`, `get_random_article` | Latest, searched or random saved articles |
| `get_digest` | Daily, weekly or monthly saved digest clusters |
| `list_feeds`, `count_feeds` | RSS feeds and their count |
| `get_statistics` | Article totals and top feeds/topics |
| `list_topics`, `list_lists`, `get_list_articles` | Topics and reading lists |
| `list_watchdogs`, `get_watchdog` | Watchdog rules and unread counts |
| `get_watchdog_matches`, `get_watchdog_match` | Saved Watchdog matches |
| `get_watchdog_notifications` | Saved notification preference |

`get_feed` accepts `count` (default 50, maximum 250) and either `topic` or
`noTopic`. `get_digest` accepts `count` and `range` (`daily`, `weekly`, `monthly`).
`search_articles` requires `field` (`title` or `url`) and `text`, with optional
`count`. `get_watchdog_matches` accepts `watchdogId`, `status`, `archived`,
`range`, `limit`, `before`, and `asOf`, using the [CLI filters](cli.md#watchdog).
`get_watchdog`, `get_watchdog_match` require `id`; `get_list_articles` requires
`name`. Tool discovery exposes full JSON Schemas; extra arguments are rejected.

Tool results include JSON text and `structuredContent.result`. Lists are arrays.
Watchdog pages include `matches` and `hasMore`; pass the last match ID as `before`
to read the next page. Read operations open SQLite with `OPEN_READONLY` and
close it after each call, so subsequent calls see the app's current saved data.
The app may remain closed for reading an existing database. Missing databases
and missing Watchdog migrations produce errors without creating or migrating
anything. A missing stored digest returns an empty array, matching the CLI.

The MCP server exposes no writes, arbitrary CLI execution, database-path
arguments, SQL, network requests, feed fetching, digest generation, or
notifications. Reading never marks anything read or archived. Watchdog
management remains available only through explicit CLI commands or the app.
Article text, URLs and user-supplied names are source data, not instructions.

Requests are limited to 1 MiB and tool output to 4 MiB. Large article queries
should use a smaller count or narrower filters. Complete topic/feed/list reads
and the articles of a named list follow the CLI's complete-result behavior;
an oversized result returns an error rather than silently truncating it.

Protocol references: [stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle),
[tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
