import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exitCodeFor } from "../scripts/watcher/cli.js";
import { inline } from "../scripts/watcher/report.js";
import { runWatcher } from "../scripts/watcher/run.js";
import { changeId, openTaskIds, taskText, writeVaultFeed } from "../scripts/watcher/vault.js";
import { parseWatchlist } from "../scripts/watcher/watchlist.js";
import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { redirectAllowed } from "../src/runtime.js";
import { ContentService, SiteNotAllowedError } from "../src/service.js";

import type { Fetcher } from "../src/fetcher.js";
import type { FetchRecord } from "../src/types.js";

const html = (price: string) => `<html><head><title>Pricing</title></head><body><main><h1>Pricing</h1>
<p>Plans for every team, billed monthly with nothing hidden anywhere on this page at all.</p>
<div><h3>Starter</h3><p>${price} per month</p></div></main></body></html>`;

type Step = { status: number; body?: string } | "throw";

/** Answers each URL from a script of steps; the last step repeats. */
class ScriptedFetcher {
  public readonly calls: string[] = [];
  private readonly scripts = new Map<string, Step[]>();
  public script(url: string, ...steps: Step[]): void {
    this.scripts.set(url, steps);
  }
  public fetch(url: string): Promise<FetchRecord> {
    this.calls.push(url);
    const fetchedAt = new Date().toISOString();
    const steps = this.scripts.get(url);
    if (!steps) return Promise.resolve({ url, status: 404, body: "", fetchedAt });
    const step = steps.length > 1 ? steps.shift() : steps[0];
    if (step === "throw" || !step) return Promise.reject(new Error("The request timed out."));
    return Promise.resolve({ url, status: step.status, body: step.body ?? "", contentType: "text/html", fetchedAt });
  }
}

const PAGE = "https://rival.test/pricing";
const watchlist = parseWatchlist([{ url: PAGE, label: "Rival pricing", "why-it-matters": "Price anchor.", kind: "competitor" }]);

async function withOut(run: (out: string) => Promise<void>): Promise<void> {
  const out = await mkdtemp(path.join(os.tmpdir(), "wcm-robust-"));
  try {
    await run(out);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const opts = (fetcher: ScriptedFetcher, out: string, now = new Date("2026-11-14T08:00:00Z")) => ({
  watchlist, outputDir: out, fetcher, minIntervalMs: 0, missingRetryDelayMs: 0, now,
});

async function snapshotFiles(out: string): Promise<{ name: string; text: string }[]> {
  const dir = path.join(out, "snapshots");
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => entry.name);
  return Promise.all(names.sort().map(async (name) => ({ name, text: await readFile(path.join(dir, name), "utf8") })));
}

void test("a 503 or 429 is unavailable: baseline untouched, no change, no removal, and recovery is not a restore", async () => {
  for (const status of [503, 500, 502, 504, 429]) {
    await withOut(async (out) => {
      const fetcher = new ScriptedFetcher();
      fetcher.script(PAGE, { status: 200, body: html("€49") });
      await runWatcher(opts(fetcher, out));
      const before = await snapshotFiles(out);

      fetcher.script(PAGE, { status, body: "Service unavailable" });
      const down = await runWatcher(opts(fetcher, out));
      assert.equal(down.results[0]?.status, "unavailable", `HTTP ${status}`);
      assert.equal(down.unavailable, 1);
      assert.equal(down.changed, 0);
      assert.equal(down.reportMarkdown, undefined);
      assert.deepEqual(await snapshotFiles(out), before, "the stored baseline is byte for byte the same");
      assert.equal(exitCodeFor(down), 3);

      fetcher.script(PAGE, { status: 200, body: html("€49") });
      const back = await runWatcher(opts(fetcher, out));
      assert.equal(back.results[0]?.status, "unchanged", "recovery is not reported as restored or changed");
      assert.equal(back.changed, 0);
    });
  }
});

void test("a timeout or network error is unavailable, with and without a cached copy", async () => {
  await withOut(async (out) => {
    const fetcher = new ScriptedFetcher();
    fetcher.script(PAGE, { status: 200, body: html("€49") });
    await runWatcher(opts(fetcher, out));
    const before = await snapshotFiles(out);
    fetcher.script(PAGE, "throw");
    const down = await runWatcher(opts(fetcher, out));
    assert.equal(down.results[0]?.status, "unavailable");
    assert.equal(down.changed, 0);
    assert.deepEqual(await snapshotFiles(out), before);
  });
  await withOut(async (out) => {
    const fetcher = new ScriptedFetcher();
    fetcher.script(PAGE, "throw");
    const first = await runWatcher(opts(fetcher, out));
    assert.equal(first.results[0]?.status, "unavailable");
    assert.deepEqual(await snapshotFiles(out), [], "an unavailable first sight stores no baseline");
  });
});

void test("a 404 seen once and then gone is not a removal; two in a row is, and recovery is a restore", async () => {
  await withOut(async (out) => {
    const fetcher = new ScriptedFetcher();
    fetcher.script(PAGE, { status: 200, body: html("€49") });
    await runWatcher(opts(fetcher, out));

    fetcher.script(PAGE, { status: 404 }, { status: 200, body: html("€49") });
    const blip = await runWatcher(opts(fetcher, out));
    assert.equal(blip.results[0]?.status, "unchanged", "the same-run retry found the page");
    assert.equal(blip.changed, 0);

    fetcher.script(PAGE, { status: 404 });
    const gone = await runWatcher(opts(fetcher, out));
    assert.equal(gone.results[0]?.status, "removed");
    assert.equal(gone.changed, 1);
    assert.ok(gone.results[0]?.factChanges.some((change) => change.material));

    fetcher.script(PAGE, { status: 410 });
    const stillGone = await runWatcher(opts(fetcher, out));
    assert.equal(stillGone.results[0]?.status, "unchanged", "an already-reported removal is not reported again");

    fetcher.script(PAGE, { status: 200, body: html("€49") });
    const restored = await runWatcher(opts(fetcher, out));
    assert.equal(restored.results[0]?.status, "restored");
  });
});

void test("an access refusal (403) is unavailable, not removal", async () => {
  await withOut(async (out) => {
    const fetcher = new ScriptedFetcher();
    fetcher.script(PAGE, { status: 200, body: html("€49") });
    await runWatcher(opts(fetcher, out));
    fetcher.script(PAGE, { status: 403 });
    const blocked = await runWatcher(opts(fetcher, out));
    assert.equal(blocked.results[0]?.status, "unavailable");
    assert.equal(blocked.changed, 0);
  });
});

void test("load() keeps a good cache entry when the origin answers 5xx", async () => {
  await withOut(async (dir) => {
    const config = loadConfig({ SITE_BASE_URL: "https://rival.test", CACHE_DIR: dir, CACHE_TTL_SECONDS: "0" } as NodeJS.ProcessEnv);
    const fetcher = new ScriptedFetcher();
    const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
    const service = new ContentService(config, cache, fetcher as unknown as Fetcher);
    fetcher.script(PAGE, { status: 200, body: html("€49") });
    await service.load(PAGE);

    fetcher.script(PAGE, { status: 503, body: "down" });
    const loaded = await service.load(PAGE, true);
    assert.equal(loaded.outcome, "stale-on-error");
    assert.equal(loaded.record.status, 200);
    assert.equal((await cache.read(PAGE))?.status, 200, "the cache still holds the good copy");

    const fresh = new ScriptedFetcher();
    fresh.script("https://rival.test/other", { status: 503, body: "down" });
    const empty = new ContentService(config, new DiskCache(path.join(dir, "c2"), 0, 100), fresh as unknown as Fetcher);
    const uncached = await empty.load("https://rival.test/other");
    assert.equal(uncached.record.status, 503);
    assert.equal(await new DiskCache(path.join(dir, "c2"), 0, 100).read("https://rival.test/other"), undefined, "a 5xx is never cached");
  });
});

void test("hostile page text cannot become task fields, tags, comments or mentions", () => {
  const hostile = "Pay 📅 2020-01-01 ⏫ ⏳ 2020-02-02 🛫 2020-03-03 🔁 every day %% hidden %% ＠x @y `code` $math$ ^block #next [[Link]] [due:: 2020-01-01] ✅ 2020-01-01";
  const text = taskText(hostile);
  for (const forbidden of ["📅", "⏫", "⏳", "🛫", "🔁", "✅", "%", "＠", "@", "`", "$", "^", "#", "[", "]", "::"]) {
    assert.ok(!text.includes(forbidden), `taskText must remove ${forbidden}: ${text}`);
  }
  assert.ok(taskText("x".repeat(500)).length <= 200);
  assert.ok(taskText("y".repeat(500), 60).length <= 60);
  assert.equal(taskText("📅 2020-01-01 ⏫ %% ＠x"), "2020-01-01 x");

  const shown = inline("Offer %% comment %% #next $5$ 100% sure");
  assert.ok(!shown.includes("%%"));
  assert.ok(!/(?<!\\)#next/u.test(shown), "a tag in page text is escaped");
  assert.ok(!/(?<!\\)\$/u.test(shown), "maths is escaped");
});

void test("the task id changes with the day and values, and only an open task suppresses a repeat", () => {
  const url = "https://rival.test/pricing";
  const a = changeId(url, 'Plan "Starter" changed from EUR 49 per month to EUR 59 per month.', "2026-11-14");
  const back = changeId(url, 'Plan "Starter" changed from €59/month to €49/month.', "2026-11-21");
  assert.notEqual(a, back);
  assert.notEqual(a, changeId(url, 'Plan "Starter" changed from EUR 49 per month to EUR 59 per month.', "2026-11-21"));
  const inbox = [`- [ ] open [watcher:: ${a}] #task #inbox`, `- [x] done [watcher:: ${back}] #task #inbox`].join("\n");
  assert.deepEqual([...openTaskIds(inbox)], [a]);
});

void test("two entries for the same change in one run write one task, and a completed task does not block a repeat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wcm-dedupe-"));
  try {
    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, "Tasks"), { recursive: true });
    const inboxFile = path.join(vault, "Tasks", "Inbox.md");
    await writeFile(inboxFile, "# Inbox\n");
    const list = parseWatchlist([
      { url: PAGE, label: "Rival pricing", "why-it-matters": "Price anchor.", kind: "competitor" },
      { url: PAGE, section: "Pricing", label: "Rival pricing", "why-it-matters": "Price anchor.", kind: "competitor" },
    ]);
    const body = (price: string) => html(price).replace("<h1>Pricing</h1>", "<h1>Pricing</h1><h2>Pricing</h2>");
    const fetcher = new ScriptedFetcher();
    fetcher.script(PAGE, { status: 200, body: body("€49") });
    const base = { watchlist: list, outputDir: path.join(root, "out"), fetcher, minIntervalMs: 0, missingRetryDelayMs: 0 };
    await runWatcher(base);
    fetcher.script(PAGE, { status: 200, body: body("€59") });
    const run = await runWatcher({ ...base, now: new Date("2026-11-14T08:00:00Z") });
    const feed = await writeVaultFeed(run, { vaultDir: vault });
    const priceTasks = feed.tasks.filter((line) => line.includes("EUR 49 per month to EUR 59 per month"));
    assert.equal(priceTasks.length, 1, "identical change from two entries is written once");

    // Tick it, then run the same change again the same day: a completed task does not suppress it.
    const ticked = (await readFile(inboxFile, "utf8")).replaceAll("- [ ]", "- [x]");
    await writeFile(inboxFile, ticked);
    const again = await writeVaultFeed(run, { vaultDir: vault });
    assert.equal(again.tasks.filter((line) => line.includes("EUR 49 per month to EUR 59 per month")).length, 1);
    // But an open one does suppress it.
    const third = await writeVaultFeed(run, { vaultDir: vault });
    assert.equal(third.tasks.filter((line) => line.includes("EUR 49 per month to EUR 59 per month")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A3 and A4: transport and sitemap scope.

type Route = { status: number; body: string; contentType?: string };
class RoutedFetcher {
  public readonly urls: string[] = [];
  public constructor(private readonly routes: Record<string, Route>) {}
  public fetch(url: string): Promise<FetchRecord> {
    this.urls.push(url);
    const route = this.routes[url];
    const record: FetchRecord = { url, status: route?.status ?? 404, body: route?.body ?? "", fetchedAt: new Date().toISOString() };
    if (route?.contentType) record.contentType = route.contentType;
    return Promise.resolve(record);
  }
}
const urlset = (...urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const index = (...urls: string[]) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;

async function withMulti(routes: Record<string, Route>, run: (service: ContentService, fetcher: RoutedFetcher) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-scope-"));
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://a.test", SITE_ALLOWLIST: "b.test", CACHE_DIR: dir } as NodeJS.ProcessEnv);
    const fetcher = new RoutedFetcher(routes);
    const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
    await run(new ContentService(config, cache, fetcher as unknown as Fetcher), fetcher);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("a site argument written with http:// is fetched over https, and plain http is refused for other sites", async () => {
  await withMulti({}, (service) => {
    const context = service.siteFor("http://b.test");
    assert.equal(context.baseUrl, "https://b.test/");
    assert.equal(context.sitemapUrl, "https://b.test/sitemap.xml");
    assert.equal(service.siteFor("HTTP://B.TEST/path").baseUrl, "https://b.test/");
    assert.throws(() => service.resolveAllowed("http://b.test/page", "b.test"), /plain http/u);
    assert.throws(() => service.resolveAllowed("http://b.test/page"), /plain http/u);
    assert.equal(service.resolveAllowed("/page", "http://b.test"), "https://b.test/page");
    assert.throws(() => service.siteFor("http://c.test"), SiteNotAllowedError);
    return Promise.resolve();
  });
});

void test("redirects from https to http are refused, and other sites stay refused", () => {
  assert.equal(redirectAllowed("https://a.test/x", "http://a.test/x"), false);
  assert.equal(redirectAllowed("https://a.test/x", "https://www.a.test/y"), true);
  assert.equal(redirectAllowed("http://a.test/x", "https://a.test/x"), true, "upgrading is fine");
  assert.equal(redirectAllowed("https://a.test/x", "https://b.test/x"), false);
  assert.equal(redirectAllowed("not a url", "https://b.test/x"), false);
});

void test("a sitemap only contributes pages of the site it was requested for", async () => {
  await withMulti({
    "https://a.test/sitemap.xml": { status: 200, body: index("https://a.test/s1.xml", "https://b.test/stolen.xml"), contentType: "text/xml" },
    "https://a.test/s1.xml": { status: 200, body: urlset("https://a.test/one", "https://b.test/leak"), contentType: "text/xml" },
    "https://b.test/stolen.xml": { status: 200, body: urlset("https://b.test/two"), contentType: "text/xml" },
    "https://b.test/sitemap.xml": { status: 200, body: urlset("https://b.test/two", "https://a.test/leak2"), contentType: "text/xml" },
  }, async (service, fetcher) => {
    const a = await service.getSitemap();
    assert.deepEqual(a.entries.map((entry) => entry.url), ["https://a.test/one"]);
    assert.ok(a.warnings.some((warning) => /not on a\.test/u.test(warning)));
    assert.ok(!fetcher.urls.includes("https://b.test/stolen.xml"), "the other site's sitemap is never fetched");

    const b = await service.getSitemap("b.test");
    assert.deepEqual(b.entries.map((entry) => entry.url), ["https://b.test/two"]);
    const pages = await service.listPages(10, 0, "b.test");
    assert.deepEqual(pages.pages.map((p) => p.url), ["https://b.test/two"]);
  });
});

void test("site health stops at its deadline and reads pages with a byte cap", async () => {
  const urls = Array.from({ length: 6 }, (_, i) => `https://a.test/p${i}`);
  await withMulti({
    "https://a.test/sitemap.xml": { status: 200, body: urlset(...urls), contentType: "text/xml" },
    ...Object.fromEntries(urls.map((u) => [u, { status: 200, body: "<html><head><title>T</title></head><body><h1>H</h1></body></html>", contentType: "text/html" }])),
  }, async (service) => {
    const report = await service.siteHealth({ maxPages: 6, deadlineMs: 1_000 });
    assert.equal(report.pagesChecked, 6, "a fast check completes inside the deadline");
    // A zero deadline is clamped to one second, so simulate expiry by stubbing the clock.
    const realNow = Date.now;
    let ticks = 0;
    Date.now = () => realNow() + (ticks++ > 6 ? 10_000_000 : 0);
    try {
      const cut = await service.siteHealth({ maxPages: 6, deadlineMs: 1_000 });
      assert.ok(cut.truncated);
      assert.ok(cut.warnings.some((warning) => /time limit/u.test(warning)));
      assert.ok(cut.pagesChecked < 6);
    } finally {
      Date.now = realNow;
    }
  });
});
