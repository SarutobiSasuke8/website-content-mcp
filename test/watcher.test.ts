import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, exitCodeFor, main } from "../scripts/watcher/cli.js";
import { diffFacts } from "../scripts/watcher/deltas.js";
import { runWatcher } from "../scripts/watcher/run.js";
import { loadWatchlist, parseWatchlist } from "../scripts/watcher/watchlist.js";
import { extractFacts } from "../src/facts.js";

import type { FetchRecord } from "../src/types.js";

const PRICING = (opts: { starter?: string; extraCta?: string; stamp?: string; footer?: string } = {}) => `<!doctype html><html><head>
<title>Pricing | Acme</title><meta name="description" content="Plans.">
</head><body><main>
<h1>Plans and pricing</h1>
<p>Our plans suit teams of every size and are billed monthly with no hidden fees at all.</p>
<p>${opts.stamp ?? "Last updated 1 November 2026"}</p>
<div class="plan-card"><h3>Starter</h3><p class="price">${opts.starter ?? "€49"} per month</p><a class="button" href="/signup?plan=starter">Choose Starter</a></div>
<div class="plan-card"><h3>Pro</h3><p class="price">€99 per month</p><a class="button" href="/signup?plan=pro">Choose Pro</a></div>
${opts.extraCta ?? ""}
${opts.footer ?? ""}
</main></body></html>`;

class SiteFetcher {
  public routes = new Map<string, { status: number; body: string; contentType?: string }>();
  public readonly urls: string[] = [];

  public set(url: string, body: string, status = 200): void {
    this.routes.set(url, { status, body, contentType: "text/html" });
  }

  public fetch(url: string): Promise<FetchRecord> {
    this.urls.push(url);
    const fetchedAt = new Date().toISOString();
    const route = this.routes.get(url);
    if (!route) return Promise.resolve({ url, status: 404, body: "", fetchedAt });
    const record: FetchRecord = { url, status: route.status, body: route.body, fetchedAt };
    if (route.contentType) record.contentType = route.contentType;
    return Promise.resolve(record);
  }
}

const watchlist = parseWatchlist({
  items: [
    { url: "https://acme.test/pricing", label: "Acme pricing", "why-it-matters": "Sets the price anchor.", kind: "competitor", project: "Astraeus Business Solutions" },
    { url: "https://own.test/about", label: "Own about", "why-it-matters": "Our own positioning.", kind: "own-site" },
  ],
});

async function listAll(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result.push(full);
    }
  }
  await walk(dir).catch(() => undefined);
  return result.sort();
}

/** Snapshot, history and report files only. The internal HTTP cache is rewritten on each run by design, and each run appends one line to the run log. */
async function outputFiles(out: string): Promise<{ file: string; text: string }[]> {
  const files = (await listAll(out)).filter((file) => !file.includes(`${path.sep}cache${path.sep}`) && path.basename(file) !== "runs.jsonl");
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
}

async function withWatcher(run: (ctx: { fetcher: SiteFetcher; out: string }) => Promise<void>): Promise<void> {
  const out = await mkdtemp(path.join(os.tmpdir(), "wcm-watcher-"));
  try {
    const fetcher = new SiteFetcher();
    fetcher.set("https://acme.test/pricing", PRICING());
    fetcher.set("https://own.test/about", "<html><head><title>About</title></head><body><article><p>We help small firms with practical websites and measured search work every week of the year.</p></article></body></html>");
    await run({ fetcher, out });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const options = (fetcher: SiteFetcher, out: string, extra: { dryRun?: boolean; now?: Date } = {}) => ({
  watchlist, outputDir: out, fetcher, minIntervalMs: 0, ...extra,
});

void test("watchlist accepts YAML and JSON, and rejects bad entries with a clear reason", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-wl-"));
  try {
    await writeFile(path.join(dir, "a.yaml"), "items:\n  - url: https://x.test/p\n    label: X\n    why-it-matters: Because.\n    kind: competitor\n    section: Pricing\n");
    await writeFile(path.join(dir, "b.json"), JSON.stringify([{ url: "https://x.test/p", label: "X", whyItMatters: "Because.", kind: "own-site", selector: "main" }]));
    assert.equal((await loadWatchlist(path.join(dir, "a.yaml"))).items[0]?.section, "Pricing");
    assert.equal((await loadWatchlist(path.join(dir, "b.json"))).items[0]?.selector, "main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.throws(() => parseWatchlist({ items: [] }), /lists no pages/u);
  assert.throws(() => parseWatchlist([{ url: "https://x.test/", label: "X", kind: "competitor" }]), /why-it-matters/u);
  assert.throws(() => parseWatchlist([{ url: "https://x.test/", site: "y.test", label: "X", "why-it-matters": "w", kind: "competitor" }]), /has site 'y.test'/u);
  assert.throws(() => parseWatchlist([{ url: "https://x.test/", label: "X", "why-it-matters": "w", kind: "rival" }]), /Invalid watchlist/u);
  assert.throws(() => parseWatchlist([{ url: "file:///etc/passwd", label: "X", "why-it-matters": "w", kind: "own-site" }]), /http or https/u);
  const twice = { url: "https://x.test/", label: "X", "why-it-matters": "w", kind: "own-site" };
  assert.throws(() => parseWatchlist([twice, twice]), /repeats/u);
});

void test("first run baselines without a report and an unchanged re-run writes nothing", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    const first = await runWatcher(options(fetcher, out));
    assert.equal(first.baselined, 2);
    assert.equal(first.changed, 0);
    assert.equal(first.reportPath, undefined);
    assert.equal(exitCodeFor(first), EXIT.OK);
    const afterFirst = await outputFiles(out);
    assert.equal(afterFirst.filter((file) => file.file.endsWith(".json") && !file.file.includes("price-history")).length, 2, "one snapshot per page");
    assert.equal(afterFirst.filter((file) => file.file.includes("price-history")).length, 1, "one price history, for the page with plans");
    assert.ok(!afterFirst.some((file) => file.file.includes("reports")), "no report");

    const second = await runWatcher(options(fetcher, out));
    assert.equal(second.unchanged, 2);
    assert.equal(second.changed, 0);
    assert.deepEqual(second.written, []);
    assert.deepEqual(await outputFiles(out), afterFirst, "snapshot and report files are byte for byte the same");
    assert.equal(exitCodeFor(second), EXIT.OK);
  });
});

void test("a price and button change is reported once, with fact deltas and the diff", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    await runWatcher(options(fetcher, out));
    fetcher.set("https://acme.test/pricing", PRICING({ starter: "€59", extraCta: '<a class="btn" href="/book">Book a demo</a>' }));
    const run = await runWatcher(options(fetcher, out, { now: new Date("2026-11-14T09:00:00Z") }));
    assert.equal(run.changed, 1);
    assert.equal(exitCodeFor(run), EXIT.CHANGED);
    assert.ok(run.reportPath?.endsWith("2026-11-14 Watcher Report.md"));

    const report = await readFile(run.reportPath as string, "utf8");
    assert.match(report, /^---\ntype: watcher-report\nmutability: append-only\nrun-date: 2026-11-14\nsource:\n\x20{2}- "https:\/\/acme\.test\/pricing"/u);
    assert.match(report, /## Material changes/u);
    assert.match(report, /Plan "Starter" price went up from EUR 49 per month to EUR 59 per month \(\+10, \+20\.4%\)/u);
    assert.match(report, /Button "Book a demo" linking to https:\/\/acme\.test\/book was added/u);
    assert.match(report, /Why it matters: Sets the price anchor\./u);
    assert.doesNotMatch(report, /Own about/u, "unchanged pages are left out of the report");
    assert.match(report, /Removed:\n\n````text\n.*€49/su);

    const material = run.results.flatMap((result) => result.factChanges.filter((change) => change.material).map((change) => change.kind));
    assert.deepEqual(material.sort(), ["cta", "price"]);

    const again = await runWatcher(options(fetcher, out));
    assert.equal(again.changed, 0, "the new version is the baseline now");
    assert.equal(again.reportPath, undefined);
  });
});

void test("two runs on the same day produce separate reports", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    const day = new Date("2026-11-14T09:00:00Z");
    await runWatcher(options(fetcher, out));
    fetcher.set("https://acme.test/pricing", PRICING({ starter: "€59" }));
    const one = await runWatcher(options(fetcher, out, { now: day }));
    fetcher.set("https://acme.test/pricing", PRICING({ starter: "€69" }));
    const two = await runWatcher(options(fetcher, out, { now: day }));
    assert.ok(one.reportPath?.endsWith("2026-11-14 Watcher Report.md"));
    assert.ok(two.reportPath?.endsWith("2026-11-14 Watcher Report 2.md"));
  });
});

void test("date stamps and spacing alone do not count as a change", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    await runWatcher(options(fetcher, out));
    const before = await outputFiles(out);
    fetcher.set("https://acme.test/pricing", PRICING({ stamp: "Last updated 14 November 2026" }));
    const run = await runWatcher(options(fetcher, out));
    assert.equal(run.changed, 0);
    assert.equal(run.results.find((result) => result.entry.label === "Acme pricing")?.noiseOnly, true);
    assert.deepEqual(await outputFiles(out), before);
  });
});

void test("a removed page is reported once, and its return is reported too", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    await runWatcher(options(fetcher, out));
    fetcher.set("https://acme.test/pricing", "", 404);
    const removed = await runWatcher(options(fetcher, out));
    assert.equal(removed.results.find((result) => result.entry.label === "Acme pricing")?.status, "removed");
    assert.ok(removed.reportPath);
    const stillGone = await runWatcher(options(fetcher, out));
    assert.equal(stillGone.changed, 0, "a page that stays gone is not reported again");
    fetcher.set("https://acme.test/pricing", PRICING());
    const restored = await runWatcher(options(fetcher, out));
    assert.equal(restored.results.find((result) => result.entry.label === "Acme pricing")?.status, "restored");
  });
});

void test("dry run fetches and compares but writes nothing, not even the output directory", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    await runWatcher(options(fetcher, out));
    const before = await outputFiles(out);
    fetcher.set("https://acme.test/pricing", PRICING({ starter: "€59" }));
    const run = await runWatcher(options(fetcher, out, { dryRun: true }));
    assert.equal(run.changed, 1);
    assert.equal(run.reportPath, undefined);
    assert.match(run.reportMarkdown ?? "", /€59/u);
    assert.deepEqual(run.written, []);
    assert.deepEqual(await outputFiles(out), before);
  });
  const missing = path.join(os.tmpdir(), `wcm-never-${Date.now()}`);
  const fetcher = new SiteFetcher();
  fetcher.set("https://acme.test/pricing", PRICING());
  fetcher.set("https://own.test/about", "<html><body><p>Hello there, this is enough text.</p></body></html>");
  const run = await runWatcher(options(fetcher, missing, { dryRun: true }));
  assert.equal(run.baselined, 2);
  assert.deepEqual(await listAll(missing), []);
});

void test("robots refusals, unmatched sections and unreachable pages become errors, not crashes", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    fetcher.routes.set("https://acme.test/robots.txt", { status: 200, body: "User-agent: *\nDisallow: /pricing\n", contentType: "text/plain" });
    const list = parseWatchlist({
      items: [
        { url: "https://acme.test/pricing", label: "Blocked", "why-it-matters": "w", kind: "competitor" },
        { url: "https://own.test/about", label: "No section", "why-it-matters": "w", kind: "own-site", section: "Does not exist" },
      ],
    });
    const run = await runWatcher({ ...options(fetcher, out), watchlist: list });
    assert.equal(run.errors, 2);
    assert.match(run.results[0]?.error ?? "", /robots\.txt/u);
    assert.match(run.results[1]?.error ?? "", /matched nothing/u);
    assert.equal(exitCodeFor(run), EXIT.ERRORS);
    assert.ok(!fetcher.urls.includes("https://acme.test/pricing"), "a disallowed page is never fetched");
  });
});

void test("a section hint compares only that section", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    const page = (footer: string, price: string) => `<html><head><title>T</title></head><body><h2>Pricing</h2><p>The Starter plan is ${price} a month for small teams who want everything.</p><h2>News</h2><p>${footer}</p></body></html>`;
    fetcher.set("https://own.test/about", page("Old news item about a launch", "€49"));
    const list = parseWatchlist([{ url: "https://own.test/about", label: "Section", "why-it-matters": "w", kind: "own-site", section: "pricing" }]);
    await runWatcher({ ...options(fetcher, out), watchlist: list });
    fetcher.set("https://own.test/about", page("Completely different news about something else", "€49"));
    assert.equal((await runWatcher({ ...options(fetcher, out), watchlist: list })).changed, 0);
    fetcher.set("https://own.test/about", page("Completely different news about something else", "€59"));
    const run = await runWatcher({ ...options(fetcher, out), watchlist: list });
    assert.equal(run.changed, 1);
    assert.ok(run.results[0]?.factChanges.some((change) => change.kind === "price"));
  });
});

void test("page text cannot break out of the report", async () => {
  await withWatcher(async ({ fetcher, out }) => {
    await runWatcher(options(fetcher, out));
    fetcher.set("https://acme.test/pricing", PRICING({ footer: "<p>```\n# Injected heading\n[[Evil Link]] ![x](http://evil.test/p.png)\n```</p>" }));
    const run = await runWatcher(options(fetcher, out));
    const report = run.reportMarkdown ?? "";
    const injected = report.split("\n").filter((line) => /^# Injected heading/u.test(line));
    assert.deepEqual(injected, [], "an injected heading must not appear at the start of a line outside a fence");
    assert.match(report, /````text/u);
  });
});

void test("diffFacts finds price, plan and button changes and ignores identical facts", () => {
  const html = (body: string) => `<html><body>${body}</body></html>`;
  const a = extractFacts(html('<div><h3>Basic</h3><p>€10 per month</p></div><a class="btn" href="/a">Join</a>'), "https://x.test/");
  const b = extractFacts(html('<div><h3>Basic</h3><p>€12 per month</p></div><div><h3>Plus</h3><p>€30 per month</p></div><a class="btn" href="/b">Join</a>'), "https://x.test/");
  assert.deepEqual(diffFacts(a, a), []);
  const descriptions = diffFacts(a, b).map((change) => `${change.kind}: ${change.description}`);
  assert.ok(descriptions.some((line) => line.startsWith("price:") && line.includes("EUR 10 per month to EUR 12 per month")));
  assert.ok(descriptions.some((line) => line.startsWith("plan:") && line.includes('"Plus"')));
  assert.ok(descriptions.some((line) => line.startsWith("cta:") && line.includes("now links to https://x.test/b")));
});

void test("the CLI prints help, rejects unknown flags and reports a missing watchlist as fatal", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  assert.equal(await main(["--help"], io), EXIT.OK);
  assert.match(out.join("\n"), /Exit codes \(run\):/u);
  assert.equal(await main(["--nonsense"], io), EXIT.FATAL);
  assert.equal(await main(["--watchlist", path.join(os.tmpdir(), "wcm-no-such-watchlist.yaml")], io), EXIT.FATAL);
  assert.match(err.join("\n"), /Watcher failed/u);
  assert.equal(await main(["--min-interval-ms", "abc"], io), EXIT.FATAL);
});
