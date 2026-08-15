# website-content-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes a website's content
in **agent-readable structured form**. Instead of scraping raw HTML, agents
(Claude, Codex, or any MCP client) pull clean markdown and structured metadata
through a small set of tools.

The server fetches pages from a configurable target site, strips them to clean
markdown, caches results to disk, respects `robots.txt`, and rate-limits requests
to be a polite citizen of the web.

## Features

- **Clean extraction** — HTML → markdown via [Mozilla Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown) (real DOM parsing, never regex). Extraction runs once per page and is cached.
- **Discovery** — page listing from `sitemap.xml`, sitemaps advertised in `robots.txt`, or a configured page list.
- **Disk cache** — fetched pages cached with a configurable TTL and a size bound; reads prefer cache, then a conditional revalidation, then stale-on-error.
- **Polite by default** — respects `robots.txt` disallow rules, rate-limits to ~1 request/second, honours `Retry-After`, and sends `If-None-Match` / `If-Modified-Since` so unchanged pages cost a `304`.
- **Scoped to one site** — fetches are refused for any host outside the configured site.
- **Two transports** — Streamable HTTP and stdio.

## Tools

| Tool | Purpose |
|------|---------|
| `content_list_pages` | List discoverable pages (sitemap → robots.txt sitemaps → configured list). Returns URL, title, last-modified when known. |
| `content_refresh` | Walk the discoverable pages and warm the cache so `content_search` has something to search. Skips robots-disallowed pages. |
| `content_get_page` | Fetch a page URL, strip to clean markdown, return content + metadata (title, canonical URL, fetched_at, content length). Supports `max_length` and `refresh`. |
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
| `USER_AGENT` | | `website-content-mcp/0.2 …` | Outbound User-Agent. |
| `HOST` | | `127.0.0.1` | HTTP bind host. |
| `PORT` | | `3215` | HTTP bind port. |

## Run

**Streamable HTTP** (default transport):

```bash
SITE_BASE_URL=https://example.com npm start
# → website-content-mcp listening on http://127.0.0.1:3215/mcp (site: https://example.com/)
```

The MCP endpoint is `POST /mcp`; a plain health probe is available at `GET /healthz`.

**stdio** (for local MCP clients):

```bash
SITE_BASE_URL=https://example.com npm run start:stdio
```

Example MCP client entry (stdio):

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

## Security & etiquette

- Binds to `127.0.0.1` by default.
- No authentication and no API keys — intended for **public** content only.
- Scoped to the configured site: a URL on any other host is refused, so the
  server cannot be used as a general-purpose fetcher. Widen deliberately with
  `SITE_ALLOWED_HOSTS`.
- Respects `robots.txt`, fetched and enforced per origin; disallowed paths are refused.
- Rate-limited to ~1 request/second against the target site.
- Response bodies are capped at `FETCH_MAX_BYTES` and the cache at `CACHE_MAX_ENTRIES`.
- Never logs full page bodies (only URLs, status codes, and sizes).

## License

[MIT](./LICENSE)
