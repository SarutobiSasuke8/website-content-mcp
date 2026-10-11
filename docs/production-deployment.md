# Production deployment

Run one process per target site. Each instance gets its own environment file,
port and cache directory, so a configuration or cache problem cannot cross
site boundaries.

## Public baseline

- Bind Node to `127.0.0.1`; terminate TLS at a reverse proxy.
- Keep `HTTP_ALLOW_REFRESH=false` for anonymous endpoints.
- Keep the bounded automatic refresh enabled so search stays current without
  exposing the refresh tool. Defaults warm 50 pages on startup and refresh
  windows of 50 pages every 5 minutes.
- Keep the application request limit enabled. Configure `HTTP_TRUST_PROXY` with
  only the actual reverse-proxy IP, CIDR or alias so `X-Forwarded-For` is used
  only from a trusted hop. For nginx on the same host, `loopback` is suitable.
- Apply a proxy request-body cap, request rate limit and timeouts.
- Do not log page bodies, raw search strings, authorization headers or cookies.
- Keep each `SITE_ALLOWED_HOSTS` list minimal and explicit.
- Use a dedicated unprivileged service account and writable cache directory.

Example site environment:

```dotenv
NODE_ENV=production
SITE_BASE_URL=https://example.com
CACHE_DIR=/var/lib/website-content-mcp/example/cache
CACHE_TTL_SECONDS=3600
CACHE_MAX_ENTRIES=500
FETCH_MIN_INTERVAL_MS=1000
HTTP_ALLOW_REFRESH=false
STARTUP_REFRESH_LIMIT=50
HTTP_REFRESH_INTERVAL_SECONDS=300
HTTP_RATE_LIMIT_WINDOW_MS=60000
HTTP_RATE_LIMIT_MAX_REQUESTS=60
HTTP_TRUST_PROXY=loopback
HOST=127.0.0.1
PORT=3215
```

The Node listener keeps HTTP sockets for 65 seconds and sets the header timeout
to 67 seconds, leaving clients time to reuse a connection between MCP
initialization and their first tool call. The nginx example allows 90 seconds
for MCP reads and writes. Match these values to the actual proxy chain; these
repository changes do not modify a live nginx configuration.

The repository includes a hardened systemd template and an nginx location
example under `deploy/`. Review user names, paths, ports and proxy topology for
the target server before installing them.

## Two-site layout

For two public sites, run two units with different environment files and ports:

```text
/etc/website-content-mcp/site-one.env  -> 127.0.0.1:3215
/etc/website-content-mcp/site-two.env  -> 127.0.0.1:3216
```

Point separate HTTPS hostnames or routes at those loopback listeners. Do not
combine targets into `SITE_ALLOWED_HOSTS` merely to save a process; isolation is
part of the product boundary.

## Verification

Before routing public traffic:

1. Confirm `GET /healthz` returns `status: ok`.
2. Send MCP `initialize` and `tools/list` requests.
3. Confirm anonymous HTTP does not list `content_refresh`.
4. Confirm `content_get_page` with `refresh: true` returns an MCP tool error.
5. Confirm `content_health` does not contain `cacheDir`.
6. Fetch a known page and verify `contentHash`, title and Markdown.
7. Attempt an off-host URL and an off-host redirect fixture; both must fail.
8. Check proxy rate limits and maximum request body behavior.

The opt-in integration test accepts a comma-separated deployment set through
`LIVE_SITE_URLS`; see the README.
