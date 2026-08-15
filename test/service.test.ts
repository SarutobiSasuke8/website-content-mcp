import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { ContentService, HostNotAllowedError, RobotsDisallowedError } from "../src/service.js";

import type { Fetcher } from "../src/fetcher.js";
import type { FetchRecord } from "../src/types.js";

const PAGE_HTML = `<html><head><title>Widgets</title></head><body><article>
<p>A reasonably long paragraph about widgets so Readability has something to chew on.
Widgets are useful, widgets are everywhere, and this sentence exists to pad the article.</p>
<p>More widget prose to clear the extraction threshold and keep the parser happy.</p>
</article></body></html>`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.test/a</loc></url>
  <url><loc>https://site.test/private/secret</loc></url>
</urlset>`;

/** Scripted fetcher: serves canned responses and records what was requested. */
class FakeFetcher {
  public readonly calls: { url: string; conditional: Record<string, string | undefined> }[] = [];

  public constructor(private readonly routes: Record<string, { status: number; body: string; contentType?: string; etag?: string }>) {}

  public fetch(url: string, conditional: { etag?: string; lastModified?: string } = {}): Promise<FetchRecord> {
    this.calls.push({ url, conditional: { ...conditional } });
    const route = this.routes[url];
    if (!route) return Promise.resolve({ url, status: 404, body: "", fetchedAt: new Date().toISOString() });
    if (conditional.etag && route.etag && conditional.etag === route.etag) {
      return Promise.resolve({ url, status: 304, body: "", fetchedAt: new Date().toISOString() });
    }
    const record: FetchRecord = { url, status: route.status, body: route.body, fetchedAt: new Date().toISOString() };
    if (route.contentType) record.contentType = route.contentType;
    if (route.etag) record.etag = route.etag;
    return Promise.resolve(record);
  }
}

function makeService(fetcher: FakeFetcher, cacheDir: string, env: Record<string, string> = {}) {
  const config = loadConfig({
    SITE_BASE_URL: "https://site.test",
    CACHE_DIR: cacheDir,
    ...env,
  } as NodeJS.ProcessEnv);
  const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
  return {
    config,
    cache,
    service: new ContentService(config, cache, fetcher as unknown as Fetcher),
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-svc-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const routes = () => ({
  "https://site.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private/\n", contentType: "text/plain" },
  "https://site.test/sitemap.xml": { status: 200, body: SITEMAP_XML, contentType: "text/xml" },
  "https://site.test/a": { status: 200, body: PAGE_HTML, contentType: "text/html", etag: 'W/"a1"' },
  "https://site.test/": { status: 200, body: PAGE_HTML, contentType: "text/html" },
});

void test("getPage refuses hosts outside the configured site", async () => {
  await withTempDir(async (dir) => {
    const fetcher = new FakeFetcher(routes());
    const { service } = makeService(fetcher, dir);

    await assert.rejects(() => service.getPage("https://evil.test/admin"), HostNotAllowedError);
    await assert.rejects(() => service.getPage("file:///etc/passwd"), HostNotAllowedError);
    assert.equal(
      fetcher.calls.some((call) => call.url.includes("evil.test")),
      false,
      "a disallowed host must never reach the network",
    );
  });
});

void test("getPage allows extra hosts only when configured", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(new FakeFetcher(routes()), dir, { SITE_ALLOWED_HOSTS: "docs.other.test" });
    assert.equal(service.resolveAllowed("https://docs.other.test/x"), "https://docs.other.test/x");
    assert.throws(() => service.resolveAllowed("https://nope.test/x"), HostNotAllowedError);
  });
});

void test("getPage enforces robots.txt for the target's own origin", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(new FakeFetcher(routes()), dir);
    await assert.rejects(() => service.getPage("/private/secret"), RobotsDisallowedError);
    const page = await service.getPage("/a");
    assert.match(page.markdown, /widgets/iu);
  });
});

void test("getPage truncates to max_length but reports the full length", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(new FakeFetcher(routes()), dir);
    const full = await service.getPage("/a");
    assert.equal(full.truncated, false);

    const clipped = await service.getPage("/a", { maxLength: 40 });
    assert.equal(clipped.markdown.length, 40);
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.contentLength, full.contentLength);
    assert.ok(clipped.contentLength > 40);
  });
});

void test("extraction is cached, so a second read never re-parses the HTML", async () => {
  await withTempDir(async (dir) => {
    const { service, cache } = makeService(new FakeFetcher(routes()), dir);
    await service.getPage("/a");

    const stored = await cache.read("https://site.test/a");
    assert.ok(stored?.extracted, "markdown is persisted alongside the raw body");
    assert.match(stored?.extracted?.markdown ?? "", /widgets/iu);
    assert.equal(stored?.extracted?.title, "Widgets");
  });
});

void test("refresh warms the cache from the sitemap and skips disallowed pages", async () => {
  await withTempDir(async (dir) => {
    const fetcher = new FakeFetcher(routes());
    const { service } = makeService(fetcher, dir);

    const result = await service.refresh(50);
    assert.equal(result.source, "sitemap");
    assert.equal(result.requested, 2);
    assert.equal(result.fetched, 1, "only the allowed page is fetched");
    assert.equal(result.skipped, 1, "the robots-disallowed page is skipped");
    assert.equal(fetcher.calls.some((call) => call.url.includes("/private/")), false);

    // Search now works without the caller fetching pages one at a time.
    const hits = await service.search("widgets", 10);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.url, "https://site.test/a");
    assert.ok(hits[0]?.score >= 1);
  });
});

void test("search ignores cached sitemaps and robots files", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(new FakeFetcher(routes()), dir);
    await service.refresh(50);

    const hits = await service.search("urlset", 10);
    assert.equal(hits.length, 0, "sitemap XML must not surface as an article hit");
  });
});

void test("a stale entry is revalidated conditionally and reused on 304", async () => {
  await withTempDir(async (dir) => {
    const fetcher = new FakeFetcher(routes());
    const { service } = makeService(fetcher, dir, { CACHE_TTL_SECONDS: "0" });

    await service.getPage("/a");
    const second = await service.getPage("/a");

    const conditionalCall = fetcher.calls.filter((call) => call.url === "https://site.test/a").at(-1);
    assert.equal(conditionalCall?.conditional.etag, 'W/"a1"', "the stored ETag is replayed");
    assert.equal(second.fromCache, true, "a 304 reuses the cached body");
    assert.match(second.markdown, /widgets/iu);
  });
});

void test("a failed fetch falls back to the stale cached copy", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(new FakeFetcher(routes()), dir);
    await service.getPage("/a");

    const broken = new FakeFetcher(routes());
    broken.fetch = () => Promise.reject(new Error("network down"));
    const { service: offline } = makeService(broken, dir, { CACHE_TTL_SECONDS: "0" });

    const page = await offline.getPage("/a");
    assert.equal(page.fromCache, true);
    assert.match(page.markdown, /widgets/iu);
  });
});

void test("health reports the allowed hosts and cache bounds", async () => {
  await withTempDir(async (dir) => {
    const { service } = makeService(new FakeFetcher(routes()), dir, { CACHE_MAX_ENTRIES: "7" });
    const health = await service.health();
    assert.deepEqual(health.allowedHosts, ["site.test"]);
    assert.equal(health.cacheMaxEntries, 7);
    assert.equal(health.cacheEntries, 0);
  });
});
