# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] — 2026-08-16

### Documentation

- Reworked the README around practical outcomes, a first-run path, an agent
  workflow and an accurate `content_get_page` result shape.
- Clarified stdio versus HTTP transport choices and the product's position as a
  site-scoped, self-hosted content layer rather than a generic scraper.

## [0.3.0] — 2026-08-16

### Security

- Redirects are now handled manually and every redirect destination is checked
  against the configured host allowlist before it reaches the network.
- Streamable HTTP now defaults to a public read-only tool surface:
  `content_refresh` is omitted, forced page revalidation is refused, and the
  local cache path is redacted from MCP health output. Operators can opt in
  with `HTTP_ALLOW_REFRESH=true` only behind a restricted proxy.

### Added

- `content_get_page` now returns a SHA-256 content hash calculated over the
  complete normalized Markdown, even when the response itself is truncated.
- Upstream `ETag`, `Last-Modified`, and validated final redirect URL are exposed
  when available.
- Bounded schema.org Product/Offer extraction for common ecommerce facts:
  product name, SKU, GTIN, brand, price, price range, currency, availability,
  product/offer URL and price-valid-until.
- MCP Registry metadata and a security policy for release readiness.
- Optional operator-controlled startup cache warming, allowing anonymous
  read-only deployments to populate search without exposing a refresh tool.
- Cross-platform CI, MCP protocol smoke, package dry-run gate and an OIDC-ready
  npm release workflow.

## [0.2.0] — 2026-08-15

### Fixed

- **`content_get_page` fetched any host.** An absolute URL to any domain was
  resolved and fetched, and the *base site's* `robots.txt` was applied to it.
  Fetches are now restricted to the configured site's host (extendable with
  `SITE_ALLOWED_HOSTS`), and `robots.txt` is fetched and enforced per origin.
- **Sitemaps could surface as search hits.** Cached XML is no longer treated as
  an article by `content_search`.

### Added

- **`content_refresh` tool.** Walks the site's discoverable pages and warms the
  cache, so `content_search` is useful without fetching every page by hand.
  Skips robots-disallowed and off-host URLs, and reports what it fetched,
  revalidated, skipped and failed.
- **Conditional requests.** Stored `ETag` / `Last-Modified` validators are
  replayed as `If-None-Match` / `If-Modified-Since`; a `304` reuses the cached
  body and resets the TTL clock.
- **`Retry-After` handling.** `429` and `503` responses are retried up to
  `FETCH_MAX_RETRIES` times, honouring `Retry-After` (capped at 30s).
- **Cache eviction.** The cache is bounded by `CACHE_MAX_ENTRIES` (default 500),
  evicting oldest-first.
- **Response size cap.** Bodies are read as a stream and stop hard at
  `FETCH_MAX_BYTES` (default 5 MB), so one oversized page cannot exhaust memory.
- **`max_length` and `refresh` on `content_get_page`.** Markdown is capped at
  50,000 characters by default; `content_length` still reports the full size and
  `truncated` flags the cut.
- New config: `SITE_ALLOWED_HOSTS`, `CACHE_MAX_ENTRIES`, `FETCH_MAX_BYTES`,
  `FETCH_MAX_RETRIES`.

### Changed

- **Markdown extraction is computed once and cached** alongside the raw body.
  `content_search` previously ran a full JSDOM parse of every cached page on
  every query.
- `content_health` now reports `allowedHosts` and `cacheMaxEntries`.

## [0.1.0] — 2026-08-14

Initial release: `content_list_pages`, `content_get_page`, `content_search`,
`content_get_sitemap` and `content_health` over Streamable HTTP and stdio, with
Readability/Turndown extraction, a TTL disk cache, `robots.txt` enforcement and
~1 req/sec rate limiting.
