# Website watcher

`website-content-watcher` is a companion command line tool in this repository. It is not part of the MCP server surface. It reads a watchlist of pages, fetches them with the same polite fetcher the server uses, keeps a snapshot of each page, and writes a Markdown report of only the pages that changed. It is deterministic: no language model is involved, so the same inputs always give the same report. A person or agent can then decide what a change means.

## What it does on each run

1. Reads the watchlist and adds every host in it to the site allowlist for the run. Nothing outside the watchlist is fetched.
2. Fetches each page, one request per second per host at most, honouring `robots.txt`. A page that robots.txt disallows is reported as an error and is not fetched. Cached validators mean an unchanged page usually costs a `304`.
3. Reduces the page to normalised Markdown plus structured facts (title, outline, calls to action, pricing signals, schema.org data, dated index items).
4. Compares both with the stored snapshot. Date stamps, copyright years and spacing are masked, so they do not count as a change.
5. Writes a report to `<out>/reports/YYYY-MM-DD Watcher Report.md` when at least one page changed, and updates the snapshots of the pages that changed.

A re-run with no changes writes no report and changes no snapshot file. The `cache/` directory under the output directory holds the HTTP cache and is refreshed on every run by design; it is not part of the evidence.

## Install and run

From a source checkout:

```bash
npm ci
npm run build
node dist/scripts/watcher/cli.js --watchlist examples/watchlist.example.yaml --out ./watcher-output --dry-run
```

From the published package, once released, the command is `website-content-watcher`.

| Option | Meaning |
|---|---|
| `--watchlist <file>` | YAML or JSON watchlist. Defaults to `watchlist.yaml`. |
| `--out <dir>` | Snapshots, reports and the HTTP cache. Defaults to `./watcher-output`. |
| `--dry-run` | Fetch and compare, write nothing at all, and print the report that would be written. |
| `--vault <dir>` | Also write the report into an Obsidian vault and add inbox task lines. See below. |
| `--min-interval-ms <n>` | Minimum time between requests to one host. Defaults to 1000. |
| `--allow-private-network` | Permit hosts that resolve to private addresses. For local test sites only. |
| `--quiet` | Print only the summary line. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Nothing changed. First-time baselines count as unchanged. |
| 1 | Fatal error, such as a bad watchlist or unknown option. |
| 2 | At least one page changed. |
| 3 | Nothing changed, but at least one page could not be checked or observed (an error, a 5xx, a 429, a timeout or a blocked request). |

When pages changed and others failed, the exit code is 2 and the failures are printed to standard error.

## Watchlist format

YAML or JSON. See [`examples/watchlist.example.yaml`](../examples/watchlist.example.yaml).

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | The page to watch. |
| `label` | yes | A short name used in reports. |
| `why-it-matters` | yes | One sentence on why a change matters. It is copied into the report. |
| `kind` | yes | `own-site` or `competitor`. |
| `site` | no | The host of the page. It defaults to the URL's host and must match it. |
| `selector` | no | A CSS selector. Only matching elements are compared. |
| `section` | no | Heading text. The heading and the content under it are compared. Use `selector` or `section`, not both. |
| `project` | no | Vault project name used on task lines, for example `Teneo`. |
| `watch` | no | What the page is: `general` (default), `pricing`, `blog`, `changelog`, `careers`, `integrations` or `security`. It decides which typed events the page can produce (see below). Plan cards are read from every page that has them. |
| `focus` | no | `focus: { selector: ".plans" }` or `focus: { heading: "Pricing" }`. The same as `selector` and `section`; use it to compare only the pricing part of a long page. |
| `ignore` | no | Noise removed before anything is read: `ignore: { selectors: [".cookie-banner", ".testimonials"], text: ["^Updated \\d+ \\w+$"] }`. A text pattern is a case-insensitive regular expression; a leaf element whose whole text matches is removed. A selector that matches nothing is fine. An invalid one is reported as an error for that page. |
| `confirm-runs` | no | 1 to 3, default 1. A change must be seen on this many consecutive runs before it is reported. A change that reverts in between is dropped. |
| `price-threshold-pct` | no | Default 0. A price change smaller than this many per cent is still listed in the note, but as low severity, so it creates no task. |
| `render` | no | `true` reads the page after its script has run. Off by default; see "Rendered pages". |

A hint that matches nothing is reported as an error, not silently ignored, so a redesign cannot make a page look unchanged.

## Severity and what counts as material

Every change has a severity. High and medium changes are material and create inbox tasks. Low changes are listed in the note and nowhere else.

| Severity | Changes |
|---|---|
| High | A plan price going up or down, a currency, billing period or per-unit change, a plan added or removed, a free tier added or removed, a page removed (HTTP 404 or 410, seen twice in one run). |
| Medium | A button added, removed or pointed elsewhere, a plan renamed, a trial added or removed, a feature added or removed on a plan, a promotion or discount banner added or removed, a change to the headline, meta description or opening paragraph, a changelog release, an integration or partner added or removed, a security or trust item added or removed, a hiring surge (three or more new roles at once), a page restored. |
| Low | Title, canonical, heading and schema type changes, a new blog post, one new role or a closed role, a price change below `price-threshold-pct`. |

### Plans and prices

Plan cards are read into a table: name, price (or range, or "from" price), currency, billing period, what the price is per (seat, user, 1k credits), free and trial flags, listed features and further rates. A `$` is called USD only when the page says USD. Currencies are never converted. Annual and quarterly prices also get a per-month equivalent in the same currency so they can be compared.

Plans are matched across runs by name, then by price and position, then by position and shared features, so a renamed plan is one `plan_renamed` event and not a removal plus an addition. A price change reports the old and new price, the absolute change and the percentage change. Buttons named after a renamed plan ("Choose Growth") are not reported again.

### Page availability

A page that answers 5xx or 429, times out, fails to connect, or refuses access (401, 403) is **unavailable** for that run. Nothing is compared or stored, no change is raised, the baseline is untouched, and the next good run carries on as if nothing had happened. Only HTTP 404 or 410 counts as removal, and only when the page is requested a second time in the same run, a few seconds later, and answers the same. The run summary and the weekly digest list unavailable pages.

### Typed events for competitor pages

| `watch` | Events |
|---|---|
| `blog` | `new_post` (title, date, link) |
| `changelog` | `new_release` for a heading that carries a version number or a date |
| `careers` | `new_role`, `role_closed`, and `hiring_surge` with the new roles counted by department |
| `integrations` | `integration_added`, `integration_removed` (logo alt text, link text and card titles) |
| `security` | `certification_added`, `certification_removed` from a fixed vocabulary (SOC 2, ISO 27001, GDPR, HIPAA, PCI DSS, sub-processor list, and similar) |
| any | `positioning_changed` for the H1, meta description or opening paragraph; `plan_*`, `price_*`, `feature_*` and `promo_*` events when the page has plan cards |

## Price history

Whenever a page's plan prices appear or change, one compact point per plan (date, price, currency, period, unit, content hash) is added to `<out>/snapshots/price-history`. A stable page adds nothing. History is bounded (two years and 2,000 points per page by default). A plan that disappears gets a "no longer listed" point; a renamed plan continues its series under the new name. The `content_price_history` MCP tool reads it (set `SNAPSHOT_DIR` to `<out>/snapshots`), and the watcher exports it:

```bash
node dist/scripts/watcher/cli.js history --out ./watcher-output --csv price-history.csv --plan Pro --since 2026-01-01
```

## Comparison note and weekly digest

```bash
node dist/scripts/watcher/cli.js compare --watchlist watchlist.yaml --out ./watcher-output --vault "<vault>"
node dist/scripts/watcher/cli.js digest --out ./watcher-output --vault "<vault>" --expect-runs 1
```

`compare` writes one living note, `Competitor Comparison.md`, to `Portfolio/Dev/MCP Servers/Watcher Output/` (or to the output directory without `--vault`) with `mutability: living`. It lists each competitor page with its plans and prices, headline price, free tier, key calls to action and the date of its last change, and it is the only file the command ever overwrites. It refuses to overwrite a note with that name that is not a watcher comparison note.

`digest` writes a dated, append-only note `YYYY-MM-DD Weekly Watcher Digest.md` covering the last seven days: high and medium events first, a price movement table, competitor signals, the count of pages that stayed unchanged, pages that were unavailable, and run health (runs against `--expect-runs`, errors, last run). It is built from the `events.jsonl` and `runs.jsonl` logs in the output directory, with no language model, so the same logs always give the same digest.

## Rendered pages

Some pages build their content with script, so the served HTML has no prices. Setting `render: true` on an entry reads that page through a browser instead. It needs the optional package `playwright-core` (about 14 MB unpacked, no browser download) and a Chrome or Edge already installed. It is not installed with the server and is never required.

- The page is checked against the site allowlist and `robots.txt`, and waits its turn in the per-host rate limit, exactly like a normal fetch.
- The browser starts with an empty profile for each page: no cookies, no saved logins, no storage, no downloads, no service workers.
- Images, media and fonts are not loaded, and every request to a host other than the page's own site is blocked. A redirect to another site is refused.
- There is a hard timeout of 30 seconds.
- If rendering is requested but cannot be done (package missing, no browser, timeout, still no readable content), the page is reported as unavailable with "rendered content unavailable" and nothing is stored for it. A script-built shell is never stored as a baseline.

A page that looks script-built but does not set `render: true` still works as before, with a warning saying so.

## Vault feed

With `--vault <dir>` the watcher also writes into an Obsidian vault. This is opt-in and never happens in tests.

- One dated note per run, only when a page changed, at `Portfolio/Dev/MCP Servers/Watcher Output/YYYY-MM-DD Watcher Report.md`. It has frontmatter `type: watcher-report`, `mutability: append-only`, `source` URLs and `run-date`. A second run on the same day gets a numbered name.
- One `#task #inbox` line per high or medium change, appended to `Tasks/Inbox.md` under a new dated heading, with `[created:: date]`, a `[watcher:: id]` marker (a hash of the page, the change with its old and new values, and the run date) that stops the same change being added twice while an unticked task for it exists, but never blocks a later real repeat once the task is ticked, and `[project:: ...]` when the watchlist entry names one. The watcher never writes `#next` and never edits `Business/Companies/`. Text taken from pages is cleaned before it reaches a task line: emoji and symbols the Tasks plugin reads as due, scheduled, start or priority markers, hashes, backticks, dollar signs, carets, at-signs, brackets, `::` and `%%` are removed, and the line is capped at 200 characters. In reports the same text appears only in code fences or with tags, comments and maths escaped.

`--dry-run` shows what would be added and writes nothing.

## Demonstration

These runs use a local fixture page served from `127.0.0.1` (the sample is `tests/fixtures/pricing.html`) so they can be repeated safely. `--allow-private-network` is needed only because the fixture is local.

1. Run 1 baselines the page: exit 0, one page baselined, no report.
2. Run 2 changes nothing: exit 0, one page unchanged, no report, no file touched.
3. The fixture is edited: the Starter price goes from €49 to €59, a button is reworded and a "Book a demo" button is added.
4. A dry run exits 2, prints the report and the four task lines it would add, and writes nothing.
5. The real run exits 2, writes `reports/YYYY-MM-DD Watcher Report.md` and, with `--vault` pointing at a temporary vault, one dated note plus four `#task #inbox` lines.
6. A further run exits 0 because the edited version is now the baseline.

The report for step 5 lists, as material changes: `Plan "Starter" changed from €49/month to €59/month`, two buttons added and one removed. The visible text was unchanged in this fixture because the page's readable body did not include the price block, which is why the report compares structured facts as well as text.

## Scheduling

Scheduling is deliberately outside the tool, and this repository does not create any schedule. Below is a proposal for a weekly Monday run. Replace the placeholder paths with your own. Run it from a checkout that has been built with `npm run build`.

The command:

```bash
node dist/scripts/watcher/cli.js --watchlist "<path to watchlist.yaml>" --out "<path to watcher data directory>" --vault "<path to vault>" --quiet
```

Exit code 2 means pages changed, which is the useful outcome. Exit code 3 means some pages could not be checked. Exit code 1 means something is misconfigured. A scheduler should treat 0 and 2 as success.

### Windows Task Scheduler (PowerShell)

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -WorkingDirectory "<path to website-content-mcp checkout>" -Argument 'dist\scripts\watcher\cli.js --watchlist "<path to watchlist.yaml>" --out "<path to watcher data directory>" --vault "<path to vault>" --quiet'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 7:30am
Register-ScheduledTask -TaskName "Website Content Watcher (weekly)" -Action $action -Trigger $trigger -Description "Checks the watchlist and writes change reports. Exit code 2 means pages changed."
```

### Claude scheduled task

A scheduled task with the cron expression `30 7 * * 1` and a prompt such as: "Run the website content watcher command from docs/watcher.md. If it exits with code 2, read the newest report in the watcher output folder and summarise the material changes in three bullets, quoting the fact changes exactly. Do not edit the watchlist or the vault beyond what the watcher itself wrote." Keep the summarising step separate from the watcher: the watcher supplies the evidence and the agent only reads it.

Check the first scheduled run by hand before relying on it, and keep the watcher data directory outside the vault so snapshots and the HTTP cache do not sync as notes.

## Limits and honesty

- Server-rendered content is compared by default. A script-built page needs `render: true` (see above); without it the page is reported with a warning and its metadata only.
- Plan cards are found by headings and by elements styled as headings. A page that shows prices in a table only, as an image, or behind a toggle may yield no plan table; the older price signals and the text diff still apply.
- The plan name is the card heading, which on some sites is a marketing line rather than a product name.
- Rendering does not check `robots.txt` for the script and data requests the page makes on its own site, only for the page itself, which is how a visitor's browser behaves.
- Selectors and sections depend on the page staying structured the same way.
- Prices are read from the text and from schema.org data. The tool reports what the page states, not what a customer would pay.
- Pages are read at the cadence you choose. Respect each site's terms; the watcher honours `robots.txt` but does not replace permission.
