import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { diffLines, findAmounts, normalizeForWatch, summarizeDiff } from "../src/diff.js";
import { ContentService } from "../src/service.js";
import { SnapshotStore } from "../src/snapshots.js";

import type { Fetcher } from "../src/fetcher.js";
import type { FetchRecord } from "../src/types.js";

void test("diffLines reports added and removed lines and ignores blank lines and spacing", () => {
  const diff = diffLines("# Plans\n\nStarter  costs €49\nPro costs €99\n", "# Plans\nStarter costs €59\nPro costs €99\nNew line\n");
  assert.deepEqual(diff.removed, ["Starter costs €49"]);
  assert.deepEqual(diff.added, ["Starter costs €59", "New line"]);
  assert.equal(diff.truncated, false);
});

void test("diffLines is deterministic and bounds its output", () => {
  const before = Array.from({ length: 300 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 300 }, (_, i) => `new ${i} ${"x".repeat(400)}`).join("\n");
  const first = diffLines(before, after, { maxLines: 10, maxLineChars: 50 });
  const second = diffLines(before, after, { maxLines: 10, maxLineChars: 50 });
  assert.deepEqual(first, second);
  assert.equal(first.added.length, 10);
  assert.equal(first.addedCount, 300);
  assert.equal(first.removedCount, 300);
  assert.equal(first.truncated, true);
  assert.ok(first.added.every((line) => line.length <= 50));
});

void test("diffLines falls back to a bounded multiset comparison for very large pages", () => {
  const before = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[1_500] = "changed in the middle";
  after.unshift("added at the top");
  const diff = diffLines(before.join("\n"), after.join("\n"));
  assert.deepEqual(diff.added.sort(), ["added at the top", "changed in the middle"]);
  assert.deepEqual(diff.removed, ["line 1500"]);
});

void test("summarizeDiff states counts, amounts and headings in one deterministic sentence", () => {
  const diff = diffLines("# Pricing\nStarter €49 a month", "# Pricing plans\nStarter €59 a month");
  const summary = summarizeDiff(diff, "Pricing", "Pricing plans");
  assert.match(summary, /2 lines added and 2 lines removed/u);
  assert.match(summary, /no longer shown: €49/u);
  assert.match(summary, /now shown: €59/u);
  assert.match(summary, /Headings: 1 added, 1 removed/u);
  assert.match(summary, /Title changed from "Pricing" to "Pricing plans"/u);
  assert.equal(summarizeDiff(diffLines("a", "a")), "No visible text lines changed.");
});

void test("findAmounts reads symbol and code forms", () => {
  assert.deepEqual(findAmounts("From €1,200.50 or $99, also 49 EUR and USD 10 but not 2026 or 15%"), ["€1,200.50", "$99", "49EUR", "USD10"]);
});

void test("normalizeForWatch masks date stamps and copyright years but keeps real content", () => {
  const a = normalizeForWatch("Updated 7 November 2026\nPosted 2026-11-07T10:00:00Z\n© 2026 Acme\nPrice €49");
  const b = normalizeForWatch("Updated 14 November 2026\nPosted 2026-11-14T09:30:00Z\n© 2027 Acme\nPrice €49");
  assert.equal(a, b);
  assert.notEqual(a, normalizeForWatch("Updated 7 November 2026\n© 2026 Acme\nPrice €59"));
});

const storeOptions = { retentionDays: 30, maxEntries: 3, maxMarkdownChars: 100 };

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-snap-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const observation = (markdown: string, hash = markdown) => ({ markdown, contentHash: hash, fetchedAt: new Date().toISOString() });

void test("SnapshotStore baselines on first sight, keeps one previous version, and writes nothing when unchanged", async () => {
  await withDir(async (dir) => {
    const store = new SnapshotStore(dir, storeOptions);
    assert.equal((await store.record("https://x.test/", observation("one"))).status, "first-seen");
    const file = path.join(dir, (await readdir(dir))[0] as string);
    const before = await stat(file);

    assert.equal((await store.record("https://x.test/", observation("one"))).status, "unchanged");
    assert.equal((await stat(file)).size, before.size);

    const changed = await store.record("https://x.test/", observation("two"));
    assert.equal(changed.status, "changed");
    assert.equal(changed.baseline?.markdown, "one");
    const stored = await store.read("https://x.test/");
    assert.equal(stored?.current.markdown, "two");
    assert.equal(stored?.previous?.markdown, "one");
  });
});

void test("SnapshotStore compare never writes, and clips stored text but keeps the full hash", async () => {
  await withDir(async (dir) => {
    const store = new SnapshotStore(dir, storeOptions);
    const compared = await store.compare("https://x.test/", observation("x".repeat(500), "fullhash"));
    assert.equal(compared.status, "first-seen");
    assert.deepEqual(await readdir(dir), []);
    await store.record("https://x.test/", observation("x".repeat(500), "fullhash"));
    const stored = await store.read("https://x.test/");
    assert.equal(stored?.current.markdown.length, 100);
    assert.equal(stored?.current.storedTruncated, true);
    assert.equal(stored?.current.contentHash, "fullhash");
  });
});

void test("SnapshotStore bounds entries and removes idle entries past retention", async () => {
  await withDir(async (dir) => {
    const store = new SnapshotStore(dir, storeOptions);
    for (const name of ["a", "b", "c", "d", "e"]) {
      await store.record(`https://x.test/${name}`, observation(name));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal((await readdir(dir)).length, 3);
    assert.equal(await store.read("https://x.test/a"), undefined);
    assert.ok(await store.read("https://x.test/e"));

    const old = new Date(Date.now() - 40 * 86_400_000);
    const oldest = path.join(dir, (await readdir(dir))[0] as string);
    await utimes(oldest, old, old);
    assert.equal(await store.prune(), 1);
    assert.equal((await readdir(dir)).length, 2);
  });
});

/** Fetcher whose responses can be switched per test, including origin failure. */
class ScriptedFetcher {
  public body = "<html><head><title>Plans</title></head><body><article><p>Starter plan costs €49 a month and includes everything a small team needs to get going quickly.</p><p>Pro plan costs €99 a month and adds reporting for teams.</p></article></body></html>";
  public fail = false;
  public etag: string | undefined = 'W/"v1"';

  public fetch(url: string, conditional: { etag?: string } = {}): Promise<FetchRecord> {
    if (this.fail) return Promise.reject(new Error("connect ECONNREFUSED"));
    const fetchedAt = new Date().toISOString();
    if (url.endsWith("/robots.txt")) return Promise.resolve({ url, status: 404, body: "", fetchedAt });
    if (conditional.etag && conditional.etag === this.etag) return Promise.resolve({ url, status: 304, body: "", fetchedAt });
    const record: FetchRecord = { url, status: 200, body: this.body, contentType: "text/html", fetchedAt };
    if (this.etag) record.etag = this.etag;
    return Promise.resolve(record);
  }
}

async function withDiffService(run: (service: ContentService, fetcher: ScriptedFetcher) => Promise<void>): Promise<void> {
  await withDir(async (dir) => {
    const config = loadConfig({ SITE_BASE_URL: "https://site.test", CACHE_DIR: path.join(dir, "cache"), CACHE_TTL_SECONDS: "0" } as NodeJS.ProcessEnv);
    const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
    const snapshots = new SnapshotStore(config.snapshotDir, storeOptions);
    const fetcher = new ScriptedFetcher();
    await run(new ContentService(config, cache, fetcher as unknown as Fetcher, snapshots), fetcher);
  });
}

void test("diffPage handles first-seen, 304 unchanged, a real change and an unchanged repeat", async () => {
  await withDiffService(async (service, fetcher) => {
    const first = await service.diffPage("/plans");
    assert.equal(first.status, "first-seen");
    assert.equal(first.changed, false);
    assert.equal(first.baselineStored, true);
    assert.equal(first.old, undefined);

    const notModified = await service.diffPage("/plans");
    assert.equal(notModified.status, "unchanged");
    assert.equal(notModified.changed, false);
    assert.equal(notModified.freshness, "not-modified");
    assert.match(notModified.summary, /304 Not Modified/u);
    assert.equal(notModified.old?.contentHash, notModified.new.contentHash);

    fetcher.body = fetcher.body.replace("€49", "€59");
    fetcher.etag = 'W/"v2"';
    const changed = await service.diffPage("/plans");
    assert.equal(changed.status, "changed");
    assert.equal(changed.changed, true);
    assert.equal(changed.freshness, "fetched");
    assert.notEqual(changed.old?.contentHash, changed.new.contentHash);
    assert.ok(changed.old?.fetchedAt && changed.new.fetchedAt);
    assert.ok(changed.diff?.added.some((line) => line.includes("€59")));
    assert.ok(changed.diff?.removed.some((line) => line.includes("€49")));
    assert.match(changed.summary, /no longer shown: €49; now shown: €59/u);

    const repeat = await service.diffPage("/plans");
    assert.equal(repeat.status, "unchanged");
    assert.equal(repeat.freshness, "not-modified");
  });
});

void test("diffPage serves a stale copy when the origin fails, says so, and does not promote it to a baseline", async () => {
  await withDiffService(async (service, fetcher) => {
    await service.getPage("/plans");
    fetcher.fail = true;
    const first = await service.diffPage("/plans");
    assert.equal(first.freshness, "stale-on-error");
    assert.equal(first.status, "first-seen");
    assert.equal(first.baselineStored, false);
    assert.ok(first.warnings?.some((warning) => warning.includes("ECONNREFUSED")));

    fetcher.fail = false;
    await service.diffPage("/plans");
    fetcher.fail = true;
    const unchanged = await service.diffPage("/plans");
    assert.equal(unchanged.freshness, "stale-on-error");
    assert.equal(unchanged.status, "unchanged");
  });
});

void test("diffPage with update_baseline false compares without storing", async () => {
  await withDiffService(async (service) => {
    const first = await service.diffPage("/plans", { update: false });
    assert.equal(first.status, "first-seen");
    assert.equal(first.baselineStored, false);
    assert.equal((await service.diffPage("/plans", { update: false })).status, "first-seen");
  });
});

void test("diffPage refuses off-site URLs and errors clearly when snapshots are disabled", async () => {
  await withDiffService(async (service) => {
    await assert.rejects(() => service.diffPage("https://evil.test/x"), /not in the allowed list/u);
  });
  await withDir(async (dir) => {
    const config = loadConfig({ SITE_BASE_URL: "https://site.test", CACHE_DIR: dir } as NodeJS.ProcessEnv);
    const service = new ContentService(config, new DiskCache(dir, 0), new ScriptedFetcher() as unknown as Fetcher);
    await assert.rejects(() => service.diffPage("/plans"), /snapshots are disabled/u);
  });
});
