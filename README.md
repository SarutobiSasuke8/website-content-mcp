# website-content-mcp

Give an AI agent a reliable, site-scoped view of a website: clean content now,
and deterministic evidence when it changes. It is a free, self-hosted
[MCP](https://modelcontextprotocol.io) server—not a general-purpose scraper—so
the agent only reads the website you configure, respects `robots.txt`, and can
show the hash and HTTP validators behind a result.

## What you can do

- **Monitor a site with evidence.** Read selected competitor or market pages on
  a schedule in a separate workflow, then compare content hashes, `ETag`s,
  prices and availability facts before alerting a human or agent.
- **Keep an agent current on your own site.** Let a support, sales or content
  agent list pages, fetch the current Markdown, and answer from what is live
  rather than from a stale upload.
- **Build a research foundation.** Turn a site's sitemap and page content into
  a bounded, attributable input for briefs, audits, catalog analysis or change
  review—without granting the agent arbitrary web-fetch access.

Unlike Firecrawl and generic scraping APIs, this project is site-scoped,
robots-compliant, deterministic about change evidence, self-hosted and free.
It is the content-access layer; scheduling, snapshots, diffs and alerts belong
in the workflow you build around it.

## Quick start: one minute to useful search

Use **stdio** for a local desktop agent. Add this to its MCP configuration:

```json
{
  "mcpServers": {
    "website-content": {
      "command": "npx",
      "args": ["-y", "-p", "@sarutobi-sasuke/website-content-mcp", "website-content-stdio"],
      "env": { "SITE_BASE_URL": "https://example.com" }
    }
  }
}
```

Then ask the agent to call `content_refresh` once. When it finishes, ask it to
call `content_search` for a topic. The cache begins empty, so search has no
pages to search until you refresh it or fetch pages individually.

Use **HTTP** when several approved remote agents need a shared endpoint. The
public HTTP transport is deliberately read-only: populate search with
`STARTUP_REFRESH_LIMIT` or a restricted operator endpoint rather than exposing
`content_refresh` anonymously.

## A real agent flow

> **Prompt:** “Summarize what is new on astraeus.ie.”
>
> 1. The agent calls `content_list_pages` to discover the site structure.
> 2. It calls `content_get_page` for the relevant current pages.
> 3. It summarizes the returned Markdown and cites the source URLs, retaining
>    `contentHash`, `ETag` and `fetchedAt` for the next comparison.

For a recurring change workflow, persist those deterministic fields outside the
MCP server, re-read the same pages later, and only ask AI to classify or
summarize a verified difference.

## Features

- **Clean extraction** — HTML → markdown via [Mozilla Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown) (real DOM parsing, never regex). Extraction runs once per page and is cached.
- **Deterministic change evidence** — each page includes a SHA-256 of the complete normalized markdown plus upstream `ETag` / `Last-Modified` validators when available.
- **Commerce-aware metadata** — bounded schema.org `Product` / `Offer` JSON-LD is returned as structured product, SKU, GTIN, brand, price, currency and availability facts.
- **Discovery** — page listing from `sitemap.xml`, sitemaps advertised in `robots.txt`, or a configured page list.
- **Disk cache** — fetched pages cached with a configurable TTL and a size bound; reads prefer cache, then a conditional revalidation, then stale-on-error.
- **Polite by default** — respects `robots.txt` disallow rules, rate-limits to ~1 request/second, honours `Retry-After`, and sends `If-None-Match` / `If-Modified-Since` so unchanged pages cost a `304`.
- **Scoped to one site** — fetches are refused for any host outside the configured site.
- **Two transports** — Streamable HTTP and stdio.

## What a page result looks like

`content_get_page` returns clean Markdown plus compact metadata that another
workflow can retain for comparison. Fields are omitted when the source does not
provide them.

```json
{
  "url": "https://shop.example/products/blue-widget",
  "title": "Blue Widget",
  "canonicalUrl": "https://shop.example/products/blue-widget",
  "markdown": "# Blue Widget\n\nA useful blue widget.",
  "contentHash": "8f3c...64-character-sha256...a91d",
  "contentLength": 38,
  "truncated": false,
  "fetchedAt": "2026-08-16T16:00:00.000Z",
  "fromCache": false,
  "etag": "W/\"widget-v4\"",
  "lastModified": "Sat, 16 Aug 2026 12:00:00 GMT",
  "products": [{
    "name": "Blue Widget",
    "sku": "BW-1",
    "brand": "Widget Co",
    "offers": [{ "price": "19.99", "priceCurrency": "EUR", "availability": "https://schema.org/InStock" }]
  }]
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `content_list_pages` | List discoverable pages (sitemap → robots.txt sitemaps → configured list). Returns URL, title, last-modified when known. |
| `content_refresh` | Walk the discoverable pages and warm the cache so `content_search` has something to search. Skips robots-disallowed pages. Available on stdio; opt-in on HTTP. |
| `content_get_page` | Fetch a page URL, strip to clean markdown, return content + metadata, content hash and any schema.org Product/Offer facts. Supports `max_length`; forced `refresh` is disabled on public HTTP by default. |
| `content_search` | Keyword search over already-fetched/cached pages. Returns URL, score, snippet. |
| `content_get_sitemap` | Return the raw sitemap structure (URLs + last-modified/priority/change-frequency when present). |
| `content_health` | Server status: configured site, allowed hosts, cache directory, cache size, last fetch time. |

The cache starts empty, so `content_search` finds nothing until pages have been
fetched. Run `content_refresh` once after starting the server (it is rate-limited
to ~1 request/second, so a 50-page pass takes about a minute), or fetch pages
individually with `content_get_page`.

## Requirements

- Node.js 22+

## Install

MCP clients can run the stdio transport without cloning the repository:

```json
{
  "mcpServers": {
    "website-content": {
      "command": "npx",
      "args": ["-y", "-p", "@sarutobi-sasuke/website-content-mcp", "website-content-stdio"],
      "env": { "SITE_BASE_URL": "https://example.com" }
    }
  }
}
```

For source development:

```bash
git clone https://github.com/SarutobiSasuke8/website-content-mcp.git
cd website-content-mcp
npm install
npm run build
```

## Configuration

Configuration is via environment variables (see [`.env.example`](./.env.example)):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SITE_BASE_URL` | ✅ | — | The site whose content is exposed. |
| `SITE_SITEMAP_URL` | | `<base>/sitemap.xml` | Sitemap location. |
| `SITE_PAGES` | | — | Comma-separated fallback page list (absolute or base-relative). |
| `SITE_ALLOWED_HOSTS` | | — | Extra hosts that may be fetched. The base URL's host is always allowed. |
| `CACHE_DIR` | | `.cache` | Disk cache directory. |
| `CACHE_TTL_SECONDS` | | `3600` | Cache TTL (0 disables caching). |
| `CACHE_MAX_ENTRIES` | | `500` | Cache size bound, evicting oldest-first (0 = unbounded). |
| `FETCH_TIMEOUT_MS` | | `10000` | Per-request timeout. |
| `FETCH_MIN_INTERVAL_MS` | | `1000` | Minimum spacing between fetches (~1 req/sec). |
| `FETCH_MAX_BYTES` | | `5000000` | Hard cap on a single response body. |
| `FETCH_MAX_RETRIES` | | `1` | Retries on 429/503, honouring `Retry-After`. |
| `USER_AGENT` | | `website-content-mcp/0.3 …` | Outbound User-Agent. |
| `HOST` | | `127.0.0.1` | HTTP bind host. |
| `PORT` | | `3215` | HTTP bind port. |
| `HTTP_ALLOW_REFRESH` | | `false` | Expose `content_refresh` and permit forced origin revalidation over HTTP. Enable only behind an authenticated or restricted reverse proxy. Stdio always permits refresh. |
| `STARTUP_REFRESH_LIMIT` | | `0` | Warm up to this many discoverable pages in the background after HTTP starts. Useful when the public refresh tool stays disabled. |

## Run

**Streamable HTTP** (default transport):

```bash
SITE_BASE_URL=https://example.com npm start
# → website-content-mcp listening on http://127.0.0.1:3215/mcp (site: https://example.com/)
```

The MCP endpoint is `POST /mcp`; a plain health probe is available at `GET /healthz`.

Streamable HTTP is deliberately public read-only by default. It omits
`content_refresh`, refuses `content_get_page(refresh: true)`, and redacts the
local cache path from MCP health output. Normal uncached reads can still reach
the configured public site and should be rate-limited at the reverse proxy.
Set `STARTUP_REFRESH_LIMIT` to populate search without exposing a public
cache-warming tool.

For a loopback Node process behind nginx/systemd, see
[`docs/production-deployment.md`](./docs/production-deployment.md).

**stdio** (for local MCP clients):

```bash
SITE_BASE_URL=https://example.com npm run start:stdio
```

Example MCP client entry from a local source checkout (stdio):

```json
{
  "mcpServers": {
    "website-content": {
      "command": "node",
      "args": ["/path/to/website-content-mcp/dist/src/stdio.js"],
      "env": { "SITE_BASE_URL": "https://example.com" }
    }
  }
}
```

## Development

```bash
npm run dev        # HTTP transport with --watch
npm run dev:stdio  # stdio transport
npm run check      # typecheck + lint + build + test
```

## Testing

- **Unit tests** cover HTML→markdown conversion, the disk cache (TTL and eviction), robots parsing, sitemap parsing, the fetcher (size cap, conditional headers, `Retry-After` retries, rate limiting) and the content service (host scoping, robots enforcement, truncation, cache warming, 304 revalidation, stale fallback). All offline, against a local fixture and a stubbed fetch.
- **A live integration test** runs against `https://example.com`, exercising `health`, `list_pages`, `get_page`, and `search`.

```bash
npm test
```

Live checks are opt-in. To validate real deployment targets, set
`RUN_LIVE_TESTS=1` and optionally provide a comma-separated `LIVE_SITE_URLS`
list before running `npm test`. Without `LIVE_SITE_URLS`, the live check uses
`https://example.com`.

## Security & etiquette

- Binds to `127.0.0.1` by default.
- No authentication and no API keys — intended for **public** content only.
- Scoped to the configured site: a URL on any other host is refused, so the
  server cannot be used as a general-purpose fetcher. Widen deliberately with
  `SITE_ALLOWED_HOSTS`.
- Redirects are followed manually and every destination is checked against the
  same host allowlist before a network request is made.
- Streamable HTTP defaults to a read-only tool surface. Keep
  `HTTP_ALLOW_REFRESH=false` for anonymous deployments.
- Respects `robots.txt`, fetched and enforced per origin; disallowed paths are refused.
- Rate-limited to ~1 request/second against the target site.
- Response bodies are capped at `FETCH_MAX_BYTES` and the cache at `CACHE_MAX_ENTRIES`.
- Never logs full page bodies (only URLs, status codes, and sizes).

## What this server is not

This project is the content-access foundation for monitoring workflows; it is
not itself a scheduler or alerting service. Competitor monitoring additionally
needs durable snapshots, deterministic diffs, a scheduler, notifications and
an evidence-retention policy. AI can classify and summarize verified changes,
but should not replace the underlying hashes, fields and source records.

## License

[MIT](./LICENSE)
