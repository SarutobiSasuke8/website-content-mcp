# Production deployment

Run one process per target site. Each instance gets its own environment file,
port and cache directory, so a configuration or cache problem cannot cross
site boundaries.

## Public baseline

- Bind Node to `127.0.0.1`; terminate TLS at a reverse proxy.
- Keep `HTTP_ALLOW_REFRESH=false` for anonymous endpoints.
- Set a bounded `STARTUP_REFRESH_LIMIT` if public search should be ready after
  startup without exposing the refresh tool.
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
HOST=127.0.0.1
PORT=3215
```

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
