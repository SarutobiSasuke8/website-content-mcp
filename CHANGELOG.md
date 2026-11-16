# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-07 (unreleased candidate)

This section combines the previously staged 0.4.0 notes (below, under "Earlier
0.4.0 notes") with the work added since. Nothing here has been published.

### Added

- `content_diff`: compare a page with the version stored by the previous call
  and return whether it changed, old and new hashes and fetch times, a bounded
  line diff and a deterministic one-line summary. First sight, unchanged, `304`
  and stale-on-error are reported explicitly. Backed by a bounded snapshot store
  (`SNAPSHOT_DIR`, `SNAPSHOT_RETENTION_DAYS`, `SNAPSHOT_MAX_ENTRIES`,
  `SNAPSHOT_MAX_MARKDOWN_CHARS`). Exposed only where refresh is allowed.
- `content_extract_facts`: bounded structured facts (title, description,
  canonical, outline, calls to action, pricing signals, schema.org types and
  Product/Offer data, dated index items). Unknown values are omitted.
- `content_site_health`: a bounded, polite health check of sitemap pages and
  internal links, grouped by severity. Exposed only where refresh is allowed.
- `SITE_ALLOWLIST` and an optional `site` argument on the page, list, sitemap,
  search and refresh tools. Robots rules, cache scope, search scope, refresh
  time and request pacing are per site.
- `website-content-watcher`, a companion command line tool with a YAML or JSON
  watchlist, snapshots, Markdown change reports, `--dry-run`, exit codes and an
  opt-in Obsidian vault feed. See `docs/watcher.md`.
- Health output now lists `siteAllowlist`; list, sitemap and refresh results
  name the `site` they describe.

### Added in the second round

- `content_price_history` reads a stored, bounded series of plan prices per page. The watcher writes it and exports it as CSV (`history` command).
- Plan-level price model in `content_extract_facts` (`pricingTable`): plan name, price or range, currency, billing period, per-unit basis, free and trial flags, features, further rates and promotion banners, plus a per-month equivalent. Plans are matched across runs so a rename is a rename.
- Watchlist options: `watch` (pricing, blog, changelog, careers, integrations, security), `focus`, `ignore`, `confirm-runs`, `price-threshold-pct` and `render`.
- Severity (high, medium, low) on every change. Only high and medium create inbox tasks.
- Typed competitor events: `new_post`, `new_release`, `new_role`, `role_closed`, `hiring_surge`, `integration_added`, `integration_removed`, `certification_added`, `certification_removed`, `positioning_changed`.
- `compare` (a living competitor comparison note) and `digest` (a deterministic weekly summary) commands, backed by `events.jsonl` and `runs.jsonl` logs.
- Optional page rendering through the optional peer dependency `playwright-core` (off by default, empty profile, same-site requests only, 30 second limit).

### Fixed in the second round

- A single 5xx, 429, timeout or access refusal is no longer treated as page removal. Such a page is unavailable for that run and its baseline is untouched. Only HTTP 404 or 410 seen twice in one run counts as removal. A 5xx or 429 also no longer overwrites a good cache entry.
- Page text can no longer inject Tasks-plugin fields, tags, comments, maths or mentions into inbox tasks or notes, and task lines are length capped.
- A `site` argument written as `http://...` is fetched over https, plain http is refused for every site except the base site, and redirects from https to http are refused.
- Sitemaps and nested sitemaps only contribute pages of the site they were requested for.
- `content_site_health` has an overall time limit and a per-fetch size cap.
- The same change is written once per run, and a price that returns to an earlier value creates a new task unless an unticked one for it exists.

### Changed

- Request pacing is now per host instead of one global interval. A request to
  one site no longer waits for another site's interval.
- Redirects to a different site are refused, even when that site is allowlisted,
  so a target's robots.txt rules can never be skipped. Redirects between the
  `www` and bare form of one host still work.
- `content_search` searches the selected site only (the base site by default)
  instead of every cached page.
- The contract suite covers the three new tools and the `site` argument.

### Documentation

- SECURITY.md states the proxy trust boundary and that the client IP is used
  only for the inbound rate limit. The `proxy-addr` advisory
  GHSA-jqcg-44mw-7w3h is already resolved by the locked 2.0.8.
- README and ROADMAP describe the new tools and put useful work ahead of
  distribution.

## Earlier 0.4.0 notes

### Added

- Automatically warm and periodically refresh bounded page windows for HTTP
  search, with the last completed refresh time in health and search results.
- Add a configurable per-IP `/mcp` request limit with `429` and `Retry-After`.
  Forwarded client IPs are used only when the proxy is explicitly trusted.

### Fixed

- Create a fresh MCP server and transport for each HTTP request. SDK 2.3.1
  and later refuse to reuse a stateless transport, which made every request
  after `initialize` fail with HTTP 500. An HTTP regression test now covers it.
- Keep HTTP sockets open long enough for clients to reuse them between MCP
  initialization and their first tool request; align the nginx example timeout.
- Describe `content_refresh` only in modes where that tool is exposed.
- Revalidate expired page cache entries on reads and cover the TTL boundary.

### Documentation

- Document refresh cadence, per-IP limits, trusted proxy configuration and the
  recommended production timeouts.

### Security

- Resolve configured destinations before each request and redirect hop and
  refuse private, loopback, link-local and special-use addresses by default.
  Deliberate internal-site deployments can opt in with
  `FETCH_ALLOW_PRIVATE_NETWORK=true`.
- Label page results as `untrusted-web-content` and state in the MCP tool
  contract that fetched text is source data, never agent instructions.

### Added

- Extraction method, quality and warnings on every page result, including a
  metadata-only fallback for client-rendered shells that previously returned
  empty Markdown.
- Discovery warnings for HTML masquerading as `robots.txt` or `sitemap.xml`.
- A bounded snapshot-and-diff dogfood runner that stores hashes, validators and
  quality evidence without retaining page bodies.

### Fixed

- Preserve spacing between adjacent utility-class block spans, preventing
  headings such as `forInstitutions` in extracted Markdown.
- Keep the MCP runtime, package and registry versions aligned through a
  release-workflow guard.

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
