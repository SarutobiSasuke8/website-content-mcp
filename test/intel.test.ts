import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectComparison, COMPARISON_FILE, renderComparison, writeComparison } from "../scripts/watcher/compare.js";
import { main } from "../scripts/watcher/cli.js";
import { buildDigest, digestFromDirectory, writeDigest } from "../scripts/watcher/digest.js";
import { runWatcher } from "../scripts/watcher/run.js";
import { writeVaultFeed } from "../scripts/watcher/vault.js";
import { parseWatchlist } from "../scripts/watcher/watchlist.js";
import { PriceHistoryStore, priceHistoryCsv } from "../src/price-history.js";

import type { PageRenderer } from "../src/render.js";
import type { FetchRecord } from "../src/types.js";

class Site {
  public readonly pages = new Map<string, { status: number; body: string }>();
  public set(url: string, body: string, status = 200): void {
    this.pages.set(url, { status, body });
  }
  public fetch(url: string): Promise<FetchRecord> {
    const fetchedAt = new Date().toISOString();
    const page = this.pages.get(url);
    if (!page) return Promise.resolve({ url, status: 404, body: "", fetchedAt });
    return Promise.resolve({ url, status: page.status, body: page.body, contentType: "text/html", fetchedAt });
  }
}

const plans = (starter: string, proName = "Pro", extra = "") => `<html><head><title>Pricing</title><meta name="description" content="Plans for teams."></head><body><main>
<h1>Plans that scale</h1><p>Simple prices, billed monthly, with nothing hidden anywhere on this page at all.</p>
<div class="cookie-banner">We use cookies. Accept?</div>
<section>
<article class="card"><h3>Starter</h3><p>${starter} per month</p><ul><li>1 site</li><li>Email support</li></ul><a class="btn" href="/s">Choose Starter</a></article>
<article class="card"><h3>${proName}</h3><p>€99 per month</p><ul><li>10 sites</li><li>Priority support</li></ul><a class="btn" href="/p">Choose Pro</a></article>
</section>${extra}</main></body></html>`;

const PRICING = "https://rival.test/pricing";
const list = (extra: Record<string, unknown> = {}) => parseWatchlist([{ url: PRICING, label: "Rival pricing", "why-it-matters": "Price anchor.", kind: "competitor", ...extra }]);
const base = (site: Site, out: string, watchlist = list(), now = new Date("2026-11-14T08:00:00Z")) => ({ watchlist, outputDir: out, fetcher: site, minIntervalMs: 0, missingRetryDelayMs: 0, now });

async function withSite(run: (ctx: { site: Site; out: string; root: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wcm-intel-"));
  try {
    const site = new Site();
    site.set(PRICING, plans("€49"));
    await run({ site, out: path.join(root, "out"), root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test("a price change is high severity with absolute and percentage change; copy changes are low", async () => {
  await withSite(async ({ site, out }) => {
    await runWatcher(base(site, out));
    site.set(PRICING, plans("€59"));
    const run = await runWatcher(base(site, out, list(), new Date("2026-11-21T08:00:00Z")));
    const change = run.results[0]?.factChanges.find((entry) => entry.type === "price_up");
    assert.equal(change?.severity, "high");
    assert.equal(change?.absoluteChange, 10);
    assert.equal(change?.percentChange, 20.4);
    assert.equal(change?.plan, "Starter");
    assert.match(run.reportMarkdown ?? "", /\(competitor, high\)/u);
  });
});

void test("a rename is reported as a rename and the price history continues under the new name", async () => {
  await withSite(async ({ site, out }) => {
    await runWatcher(base(site, out));
    site.set(PRICING, plans("€49", "Growth"));
    const run = await runWatcher(base(site, out, list(), new Date("2026-11-21T08:00:00Z")));
    const types = run.results[0]?.factChanges.map((entry) => entry.type) ?? [];
    assert.deepEqual(types.filter((type) => type?.startsWith("plan_")), ["plan_renamed"]);
    const history = await new PriceHistoryStore(path.join(out, "snapshots", "price-history")).read(PRICING);
    const growth = history.points.filter((point) => point.plan === "Growth");
    assert.equal(growth.length, 1);
    assert.equal(growth[0]?.renamedFrom, "Pro");
    assert.ok(!history.points.some((point) => point.plan === "Pro" && point.amount === null), "no false removal is recorded");
  });
});

void test("a rename explains the buttons named after the plan, and later runs do not record a false removal", async () => {
  await withSite(async ({ site, out }) => {
    await runWatcher(base(site, out));
    site.set(PRICING, plans("€49", "Growth"));
    const run = await runWatcher(base(site, out, list(), new Date("2026-11-21T08:00:00Z")));
    const types = run.results[0]?.factChanges.map((entry) => entry.type) ?? [];
    assert.ok(types.includes("plan_renamed"));
    assert.ok(!types.some((type) => type?.startsWith("cta_")), "Choose Pro and Choose Growth are not reported separately");

    // A later price change on another plan must not close the renamed plan's series.
    site.set(PRICING, plans("€59", "Growth"));
    await runWatcher(base(site, out, list(), new Date("2026-11-28T08:00:00Z")));
    const history = await new PriceHistoryStore(path.join(out, "snapshots", "price-history")).read(PRICING);
    assert.ok(!history.points.some((point) => point.plan === "Pro" && point.amount === null));
  });
});

void test("ignore rules remove noise before comparing", async () => {
  await withSite(async ({ site, out }) => {
    const watchlist = list({ ignore: { selectors: [".cookie-banner"], text: ["^Updated \\d+ [A-Za-z]+$"] } });
    site.set(PRICING, plans("€49", "Pro", "<p>Updated 3 November</p>"));
    await runWatcher(base(site, out, watchlist));
    site.set(PRICING, plans("€49", "Pro", "<p>Updated 9 December</p>").replace("We use cookies. Accept?", "Cookies are used. Accept all?"));
    const run = await runWatcher(base(site, out, watchlist, new Date("2026-11-21T08:00:00Z")));
    assert.equal(run.changed, 0, "a rotating banner and a stamp are not changes");
    assert.equal(run.unchanged, 1);
    // Without the rules the same edit counts as a change.
    const plain = await runWatcher(base(site, path.join(out, "plain"), list()));
    site.set(PRICING, plans("€49", "Pro", "<p>Updated 9 December</p>").replace("We use cookies. Accept?", "Something else entirely about cookies."));
    const noisy = await runWatcher(base(site, path.join(out, "plain"), list(), new Date("2026-11-21T08:00:00Z")));
    assert.equal(plain.baselined, 1);
    assert.equal(noisy.changed, 1);
  });
});

void test("a bad ignore rule is an error for that page, not a crash", async () => {
  await withSite(async ({ site, out }) => {
    const run = await runWatcher(base(site, out, list({ ignore: { text: ["(unclosed"] } })));
    assert.equal(run.results[0]?.status, "error");
    assert.match(run.results[0]?.error ?? "", /not a valid regular expression/u);
  });
});

void test("confirm-runs holds a change back until it is seen on consecutive runs", async () => {
  await withSite(async ({ site, out }) => {
    const watchlist = list({ "confirm-runs": 2 });
    await runWatcher(base(site, out, watchlist));
    site.set(PRICING, plans("€59"));
    const first = await runWatcher(base(site, out, watchlist, new Date("2026-11-15T08:00:00Z")));
    assert.equal(first.results[0]?.status, "pending");
    assert.equal(first.changed, 0);
    assert.equal(first.reportMarkdown, undefined);

    // The change reverts: the counter is cleared and nothing is reported.
    site.set(PRICING, plans("€49"));
    const reverted = await runWatcher(base(site, out, watchlist, new Date("2026-11-16T08:00:00Z")));
    assert.equal(reverted.results[0]?.status, "unchanged");

    // It appears twice in a row: now it counts.
    site.set(PRICING, plans("€59"));
    await runWatcher(base(site, out, watchlist, new Date("2026-11-17T08:00:00Z")));
    const confirmed = await runWatcher(base(site, out, watchlist, new Date("2026-11-18T08:00:00Z")));
    assert.equal(confirmed.results[0]?.status, "changed");
    assert.ok(confirmed.results[0]?.factChanges.some((entry) => entry.type === "price_up"));
  });
});

void test("the price threshold keeps a small change out of the tasks but in the note", async () => {
  await withSite(async ({ site, out, root }) => {
    const watchlist = list({ "price-threshold-pct": 5 });
    await runWatcher(base(site, out, watchlist));
    site.set(PRICING, plans("€50"));
    const run = await runWatcher(base(site, out, watchlist, new Date("2026-11-21T08:00:00Z")));
    const price = run.results[0]?.factChanges.find((entry) => entry.type === "price_up");
    assert.equal(price?.severity, "low");
    assert.equal(price?.material, false);

    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, "Tasks"), { recursive: true });
    await writeFile(path.join(vault, "Tasks", "Inbox.md"), "# Inbox\n");
    const feed = await writeVaultFeed(run, { vaultDir: vault });
    assert.equal(feed.tasks.length, 0, "a low-severity change creates no task");
    assert.match(await readFile(feed.notePath ?? "", "utf8"), /below the materiality threshold/u);
  });
});

const POSTS = (...titles: string[]) => `<html><head><title>Blog</title></head><body><main><h1>News</h1>${titles.map((title, index) => `<article><h2><a href="/blog/${index}-${title.length}">${title}</a></h2><time datetime="2026-11-0${index + 1}">2026-11-0${index + 1}</time></article>`).join("")}</main></body></html>`;

void test("typed competitor events: new post, new roles with a hiring surge, integrations, certifications and releases", async () => {
  await withSite(async ({ site, out }) => {
    const entries = [
      { url: "https://rival.test/blog", label: "Blog", watch: "blog" },
      { url: "https://rival.test/careers", label: "Careers", watch: "careers" },
      { url: "https://rival.test/integrations", label: "Integrations", watch: "integrations" },
      { url: "https://rival.test/security", label: "Security", watch: "security" },
      { url: "https://rival.test/changelog", label: "Changelog", watch: "changelog" },
    ].map((entry) => ({ ...entry, "why-it-matters": "Signal.", kind: "competitor" }));
    const watchlist = parseWatchlist(entries);
    const jobs = (...roles: [string, string][]) => `<html><head><title>Careers</title></head><body><main><h1>Join us</h1>${[...new Set(roles.map((r) => r[1]))].map((dept) => `<h2>${dept}</h2><ul>${roles.filter((r) => r[1] === dept).map((r) => `<li><a href="/jobs/${r[0].replace(/\W+/gu, "-")}">${r[0]}</a> Dublin</li>`).join("")}</ul>`).join("")}</main></body></html>`;
    site.set("https://rival.test/blog", POSTS("First post", "Second post"));
    site.set("https://rival.test/careers", jobs(["Backend Engineer", "Engineering"]));
    site.set("https://rival.test/integrations", `<html><body><main><h1>Integrations</h1><ul><li><a href="/i/slack">Slack</a></li><li><a href="/i/zapier">Zapier</a></li></ul></main></body></html>`);
    site.set("https://rival.test/security", `<html><body><main><h1>Trust</h1><p>We are GDPR compliant and hold ISO 27001.</p></main></body></html>`);
    site.set("https://rival.test/changelog", `<html><body><main><h1>Changelog</h1><h2>v1.2.0 (2026-10-01)</h2><p>Fixes.</p></main></body></html>`);
    await runWatcher(base(site, out, watchlist));

    site.set("https://rival.test/blog", POSTS("First post", "Second post", "Third post"));
    site.set("https://rival.test/careers", jobs(["Backend Engineer", "Engineering"], ["Frontend Engineer", "Engineering"], ["Data Engineer", "Engineering"], ["Account Executive", "Sales"]));
    site.set("https://rival.test/integrations", `<html><body><main><h1>Integrations</h1><ul><li><a href="/i/slack">Slack</a></li><li><a href="/i/zapier">Zapier</a></li><li><a href="/i/hubspot">HubSpot</a></li></ul></main></body></html>`);
    site.set("https://rival.test/security", `<html><body><main><h1>Trust</h1><p>We are GDPR compliant and hold ISO 27001 and SOC 2 Type II.</p></main></body></html>`);
    site.set("https://rival.test/changelog", `<html><body><main><h1>Changelog</h1><h2>v1.3.0 (2026-11-10)</h2><p>New.</p><h2>v1.2.0 (2026-10-01)</h2><p>Fixes.</p></main></body></html>`);
    const run = await runWatcher(base(site, out, watchlist, new Date("2026-11-21T08:00:00Z")));

    const byLabel = (label: string) => (run.results.find((result) => result.entry.label === label)?.factChanges ?? []).filter((change) => change.type !== undefined && change.type !== "positioning_changed");
    assert.deepEqual(byLabel("Blog").map((c) => [c.type, c.severity]), [["new_post", "low"]]);
    const careers = byLabel("Careers");
    assert.equal(careers.filter((c) => c.type === "new_role").length, 3);
    const surge = careers.find((c) => c.type === "hiring_surge");
    assert.equal(surge?.severity, "medium");
    assert.match(surge?.description ?? "", /Engineering 2, Sales 1/u);
    assert.deepEqual(byLabel("Integrations").map((c) => [c.type, c.severity]), [["integration_added", "medium"]]);
    const trust = byLabel("Security").filter((c) => c.type?.startsWith("certification"));
    assert.deepEqual(trust.map((c) => c.type), ["certification_added"]);
    assert.match(trust[0]?.description ?? "", /SOC 2/u);
    assert.deepEqual(byLabel("Changelog").map((c) => [c.type, c.severity]), [["new_release", "medium"]]);
  });
});

void test("positioning changes (headline, description) are medium and button changes are not double counted", async () => {
  await withSite(async ({ site, out }) => {
    await runWatcher(base(site, out));
    site.set(PRICING, plans("€49").replace("Plans that scale", "Plans that adapt").replace("Plans for teams.", "Pricing for fast teams."));
    const run = await runWatcher(base(site, out, list(), new Date("2026-11-21T08:00:00Z")));
    const positioning = run.results[0]?.factChanges.filter((entry) => entry.type === "positioning_changed") ?? [];
    assert.equal(positioning.length, 2);
    assert.ok(positioning.every((entry) => entry.severity === "medium"));
    site.set(PRICING, plans("€49").replace("Plans that scale", "Plans that adapt").replace("Plans for teams.", "Pricing for fast teams.").replace("Choose Starter", "Start now"));
    const buttons = await runWatcher(base(site, out, list(), new Date("2026-11-28T08:00:00Z")));
    assert.ok(!buttons.results[0]?.factChanges.some((entry) => entry.type === "positioning_changed"));
  });
});

class FakeRenderer implements PageRenderer {
  public calls = 0;
  public constructor(private readonly html: string, private readonly finalUrl = "https://app.test/") {}
  public render(): Promise<{ html: string; finalUrl: string }> {
    this.calls += 1;
    return Promise.resolve({ html: this.html, finalUrl: this.finalUrl });
  }
}

void test("rendering is opt-in; with it the prices of a script-built page are read, without it the page says so", async () => {
  const shell = `<html><head><title>App</title><meta name="description" content="An app."></head><body><div id="root"></div><script src="/main.js"></script></body></html>`;
  const rendered = `<html><head><title>App</title></head><body><main><h1>Plans</h1><p>Simple prices for every team size, billed monthly with no hidden extras at all.</p><article><h3>Pilot</h3><p>From €5,200</p></article><article><h3>Managed</h3><p>From €1,750/mo</p></article></main></body></html>`;
  const make = (extra: Record<string, unknown>) => parseWatchlist([{ url: "https://app.test/", label: "App", "why-it-matters": "Prices.", kind: "competitor", ...extra }]);

  await withSite(async ({ site, out }) => {
    site.set("https://app.test/", shell);
    const renderer = new FakeRenderer(rendered);

    // Off by default: no renderer is called and the warning explains the next step.
    const off = await runWatcher({ ...base(site, path.join(out, "a"), make({})), renderer });
    assert.equal(renderer.calls, 0);
    assert.match(off.results[0]?.warnings.join(" ") ?? "", /set render: true/u);

    const on = await runWatcher({ ...base(site, path.join(out, "b"), make({ render: true })), renderer });
    assert.equal(renderer.calls, 1);
    assert.equal(on.results[0]?.status, "baselined");
    const snap = await new PriceHistoryStore(path.join(out, "b", "snapshots", "price-history")).read("https://app.test/");
    assert.deepEqual(snap.points.map((point) => [point.plan, point.amount, point.period]), [["Pilot", 5200, undefined], ["Managed", 1750, "month"]]);

    // Rendering asked for but no renderer: marked unavailable and nothing is stored.
    const none = await runWatcher(base(site, path.join(out, "c"), make({ render: true })));
    assert.ok(["unavailable", "error"].includes(none.results[0]?.status ?? ""));
    assert.match(none.results[0]?.error ?? "", /rendered content unavailable/u);
    assert.deepEqual(await readdir(path.join(out, "c", "snapshots")).catch(() => []), []);

    // The page is still empty after rendering: not stored as a baseline.
    const empty = await runWatcher({ ...base(site, path.join(out, "d"), make({ render: true })), renderer: new FakeRenderer(shell) });
    assert.equal(empty.results[0]?.status, "unavailable");
    assert.match(empty.results[0]?.error ?? "", /still had no readable content/u);

    // A render that ends on another site is refused.
    const away = await runWatcher({ ...base(site, path.join(out, "e"), make({ render: true })), renderer: new FakeRenderer(rendered, "https://elsewhere.test/") });
    assert.equal(away.results[0]?.status, "unavailable");
    assert.match(away.results[0]?.error ?? "", /different site/u);
  });
});

void test("price history is bounded, skips unchanged pages, marks removals and exports safe CSV", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wcm-hist-"));
  try {
    const store = new PriceHistoryStore(root, { retentionDays: 30, maxPointsPerPage: 5 });
    const table = (price: number, name = "Pro") => ({ promos: [], plans: [{ name, position: 0, amount: price, currency: "EUR", period: "month" as const, features: [] }] });
    assert.equal(await store.record("https://x.test/p", table(10), { date: "2026-11-01", source: "h1" }), 1);
    assert.equal(await store.record("https://x.test/p", table(10), { date: "2026-11-08", source: "h1" }), 0, "no change adds nothing");
    assert.equal(await store.record("https://x.test/p", table(12), { date: "2026-11-15", source: "h2" }), 1);
    assert.equal(await store.record("https://x.test/p", { promos: [], plans: [] }, { date: "2026-11-16", source: "h3" }), 0, "an empty table is not evidence of removal");
    assert.equal(await store.record("https://x.test/p", table(5, "Other"), { date: "2026-11-22", source: "h4" }), 2, "new plan plus removal of the old one");
    for (let n = 0; n < 10; n += 1) await store.record("https://x.test/p", table(20 + n, "Other"), { date: "2026-11-23", source: `h${n + 5}` });
    const history = await store.read("https://x.test/p");
    assert.ok(history.points.length <= 5);
    assert.deepEqual(PriceHistoryStore.latest(history.points).map((point) => point.plan), ["Other"]);

    const csv = priceHistoryCsv([{ url: "https://x.test/=cmd", points: [{ date: "2026-11-01", plan: "=HYPERLINK(\"x\")", amount: 12, currency: "EUR", period: "year", source: "abcdef0123456789" }] }]);
    const [header, row] = csv.trim().split("\n");
    assert.equal(header, "date,url,plan,amount,max_amount,currency,period,unit,per_month,source_hash,note");
    assert.ok(row?.includes("'=HYPERLINK"), "a formula in a plan name is neutralised");
    assert.ok(row?.includes(",1,"), "annual 12 is 1 per month");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("the comparison note is a living note, overwrites only itself and states unknowns", async () => {
  await withSite(async ({ site, out, root }) => {
    const watchlist = parseWatchlist([
      { url: PRICING, label: "Rival pricing", "why-it-matters": "Anchor.", kind: "competitor" },
      { url: "https://other.test/", label: "Not yet fetched", "why-it-matters": "Anchor.", kind: "competitor" },
      { url: "https://ours.test/", label: "Ours", "why-it-matters": "Reference.", kind: "own-site" },
    ]);
    site.set("https://ours.test/", "<html><body><main><h1>Ours</h1></main></body></html>");
    await runWatcher({ ...base(site, out, watchlist) });
    const rows = await collectComparison(watchlist, out);
    assert.equal(rows.length, 2, "own pages are left out by default");
    const markdown = renderComparison(rows, { now: new Date("2026-11-14T00:00:00Z") });
    assert.match(markdown, /^---\ntype: watcher-comparison\nmutability: living\nupdated: 2026-11-14\n/u);
    assert.match(markdown, /Starter: EUR 49 per month; Pro: EUR 99 per month/u);
    assert.match(markdown, /\| EUR 49 per month \(Starter\) \| none listed \| Choose Starter; Choose Pro/u);
    assert.match(markdown, /Not yet fetched \| no data yet/u);

    const directory = path.join(root, "vault-dir");
    const file = await writeComparison(markdown, directory);
    assert.equal(path.basename(file), COMPARISON_FILE);
    await writeComparison(markdown.replace("2026-11-14", "2026-11-21"), directory);
    assert.match(await readFile(file, "utf8"), /updated: 2026-11-21/u);

    // A different note with that name is never replaced.
    await writeFile(file, "# My own note\n");
    await assert.rejects(writeComparison(markdown, directory), /not a watcher comparison note/u);
    assert.equal(await readFile(file, "utf8"), "# My own note\n");
  });
});

void test("the weekly digest orders events, tables price movement, counts the rest and reports run health", async () => {
  await withSite(async ({ site, out }) => {
    await runWatcher(base(site, out, list(), new Date("2026-11-08T08:00:00Z")));
    site.set(PRICING, plans("€59", "Growth"));
    await runWatcher(base(site, out, list(), new Date("2026-11-15T08:00:00Z")));
    site.set(PRICING, plans("€59", "Growth"), 503);
    await runWatcher(base(site, out, list(), new Date("2026-11-16T08:00:00Z")));

    const digest = await digestFromDirectory(out, { now: new Date("2026-11-17T09:00:00Z"), expectedRuns: 2 });
    assert.equal(digest.runs, 2, "only runs inside the window count");
    assert.equal(digest.missedRuns, 0);
    assert.match(digest.markdown, /^---\ntype: watcher-digest\nmutability: append-only\nwindow-start: 2026-11-10\nwindow-end: 2026-11-17\n/u);
    assert.match(digest.markdown, /## High and medium events\n\n- \[high\] 2026-11-15 \*\*Rival pricing\*\*/u);
    assert.match(digest.markdown, /\| 2026-11-15 \| Rival pricing \| Starter \| price_up \| EUR 49 per month \| EUR 59 per month \| \+10 \| \+20\.4% \|/u);
    assert.match(digest.markdown, /\| Growth \| plan_renamed \| Pro \| Growth \|/u);
    assert.match(digest.markdown, /## Pages that were unavailable\n\n\| Page \| Problem \| Runs affected \| Last reason \|\n\|---\|---\|---\|---\|\n\| Rival pricing \| unavailable \| 1 \| HTTP 503 \|/u);
    assert.match(digest.markdown, /Runs in the window: 2 of 2 expected\./u);

    const missed = buildDigest([], [], { now: new Date("2026-11-17T09:00:00Z") });
    assert.equal(missed.missedRuns, 1);
    assert.match(missed.markdown, /1 missed/u);
    assert.match(missed.markdown, /None this week\./u);

    const file = await writeDigest(digest, path.join(path.dirname(out), "digests"));
    assert.ok(file.endsWith("2026-11-17 Weekly Watcher Digest.md"));
    const again = await writeDigest(digest, path.join(path.dirname(out), "digests"));
    assert.ok(again.endsWith("2026-11-17 Weekly Watcher Digest 2.md"), "an earlier digest is never overwritten");
  });
});

void test("the CLI runs compare, digest and history without touching the network", async () => {
  await withSite(async ({ site, out, root }) => {
    await runWatcher(base(site, out));
    site.set(PRICING, plans("€59"));
    await runWatcher(base(site, out, list(), new Date("2026-11-21T08:00:00Z")));
    const watchlistFile = path.join(root, "w.json");
    await writeFile(watchlistFile, JSON.stringify([{ url: PRICING, label: "Rival pricing", whyItMatters: "Anchor.", kind: "competitor" }]));
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };

    assert.equal(await main(["compare", "--watchlist", watchlistFile, "--out", out, "--dry-run"], io), 0);
    assert.match(lines.join("\n"), /Competitor comparison/u);
    const csvFile = path.join(root, "history.csv");
    assert.equal(await main(["history", "--out", out, "--csv", csvFile], io), 0);
    assert.match(await readFile(csvFile, "utf8"), /Starter,59,,EUR,month,,59,/u);
    assert.equal(await main(["digest", "--out", out, "--dry-run", "--days", "60"], io), 0);
    assert.equal(await main(["nonsense"], io), 1);
    assert.equal(await main(["digest", "extra", "--out", out], io), 1);
  });
});
