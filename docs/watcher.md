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
| 3 | Nothing changed, but at least one page could not be checked. |

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

A hint that matches nothing is reported as an error, not silently ignored, so a redesign cannot make a page look unchanged.

## What counts as material

The report lists every change, but these are flagged as material because they usually need a decision:

- a price change, including a price that appears or disappears;
- a plan or tier that appears or disappears;
- a call to action that is added, removed or pointed somewhere else;
- a page that is removed (HTTP 4xx or 5xx) or comes back.

Title, description, canonical, heading, schema type and new blog entry changes are reported as other fact changes. Only material changes create vault task lines.

## Vault feed

With `--vault <dir>` the watcher also writes into an Obsidian vault. This is opt-in and never happens in tests.

- One dated note per run, only when a page changed, at `Portfolio/Dev/MCP Servers/Watcher Output/YYYY-MM-DD Watcher Report.md`. It has frontmatter `type: watcher-report`, `mutability: append-only`, `source` URLs and `run-date`. A second run on the same day gets a numbered name.
- One `#task #inbox` line per material change, appended to `Tasks/Inbox.md` under a new dated heading, with `[created:: date]`, a `[watcher:: id]` marker that stops the same change being added twice, and `[project:: ...]` when the watchlist entry names one. The watcher never writes `#next` and never edits `Business/Companies/`.

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

- Only server-rendered content is compared. A client-rendered page is reported with a warning and its metadata only.
- Selectors and sections depend on the page staying structured the same way.
- Prices are read from the text and from schema.org data. The tool reports what the page states, not what a customer would pay.
- Pages are read at the cadence you choose. Respect each site's terms; the watcher honours `robots.txt` but does not replace permission.
