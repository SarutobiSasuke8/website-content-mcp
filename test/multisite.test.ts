import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { Fetcher } from "../src/fetcher.js";
import { createRuntime } from "../src/runtime.js";
import { ContentService, HostNotAllowedError, RobotsDisallowedError, SiteNotAllowedError } from "../src/service.js";

import type { FetchRecord } from "../src/types.js";

const page = (heading: string) => `<html><head><title>${heading}</title></head><body><article>
<p>${heading} is a reasonably long paragraph so that Readability has enough text to treat this as an article about ${heading}.</p>
<p>A second paragraph about ${heading} keeps the extractor happy and gives search something to match on.</p>
</article></body></html>`;

type Route = { status: number; body: string; contentType?: string };

class RoutedFetcher {
  public readonly urls: string[] = [];
  public constructor(private readonly routes: Record<string, Route>) {}

  public fetch(url: string): Promise<FetchRecord> {
    this.urls.push(url);
    const route = this.routes[url];
    const record: FetchRecord = route
      ? { url, status: route.status, body: route.body, fetchedAt: new Date().toISOString() }
      : { url, status: 404, body: "", fetchedAt: new Date().toISOString() };
    if (route?.contentType) record.contentType = route.contentType;
    return Promise.resolve(record);
  }
}

const sitemap = (...urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

const routes = (): Record<string, Route> => ({
  "https://a.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /secret\n", contentType: "text/plain" },
  "https://a.test/sitemap.xml": { status: 200, body: sitemap("https://a.test/one"), contentType: "text/xml" },
  "https://a.test/one": { status: 200, body: page("Alpha"), contentType: "text/html" },
  "https://a.test/shared": { status: 200, body: page("Alpha shared"), contentType: "text/html" },
  "https://b.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /shared\n", contentType: "text/plain" },
  "https://b.test/sitemap.xml": { status: 200, body: sitemap("https://b.test/two"), contentType: "text/xml" },
  "https://b.test/two": { status: 200, body: page("Bravo"), contentType: "text/html" },
  "https://b.test/shared": { status: 200, body: page("Bravo shared"), contentType: "text/html" },
});

async function withService(
  run: (ctx: { service: ContentService; fetcher: RoutedFetcher }) => Promise<void>,
  env: Record<string, string> = { SITE_ALLOWLIST: "b.test" },
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-multi-"));
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://a.test", CACHE_DIR: dir, ...env } as NodeJS.ProcessEnv);
    const fetcher = new RoutedFetcher(routes());
    const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
    await run({ service: new ContentService(config, cache, fetcher as unknown as Fetcher), fetcher });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("SITE_ALLOWLIST adds sites alongside the base site and accepts hosts or URLs", () => {
  const config = loadConfig({ SITE_BASE_URL: "https://a.test", SITE_ALLOWLIST: "b.test, https://www.c.test/" } as NodeJS.ProcessEnv);
  assert.deepEqual(config.siteAllowlist, ["a.test", "b.test", "c.test"]);
  for (const host of config.siteAllowlist) assert.ok(config.allowedHosts.includes(host));
  assert.deepEqual(loadConfig({ SITE_BASE_URL: "https://a.test" } as NodeJS.ProcessEnv).siteAllowlist, ["a.test"]);
});

void test("a site that is not allowlisted is refused before any network access", async () => {
  await withService(async ({ service, fetcher }) => {
    await assert.rejects(() => service.getPage("/", { site: "evil.test" }), SiteNotAllowedError);
    await assert.rejects(() => service.listPages(10, 0, "https://evil.test"), SiteNotAllowedError);
    await assert.rejects(() => service.getSitemap("evil.test"), SiteNotAllowedError);
    await assert.rejects(() => service.refresh(5, false, 0, "evil.test"), SiteNotAllowedError);
    await assert.rejects(() => service.search("x", 5, "evil.test"), SiteNotAllowedError);
    assert.equal(fetcher.urls.length, 0);
  });
});

void test("an absolute URL on another host is refused, with or without a site argument", async () => {
  await withService(async ({ service, fetcher }) => {
    await assert.rejects(() => service.getPage("https://evil.test/x"), HostNotAllowedError);
    await assert.rejects(() => service.getPage("https://evil.test/x", { site: "b.test" }), HostNotAllowedError);
    // a.test is allowlisted, but asking for it under site b.test is a mismatch
    await assert.rejects(() => service.getPage("https://a.test/one", { site: "b.test" }), HostNotAllowedError);
    assert.equal(fetcher.urls.length, 0);
  });
});

void test("the site argument defaults to the base site and selects an allowlisted site", async () => {
  await withService(async ({ service }) => {
    const base = await service.getPage("/one");
    assert.equal(base.url, "https://a.test/one");
    const other = await service.getPage("/two", { site: "b.test" });
    assert.equal(other.url, "https://b.test/two");
    assert.equal((await service.listPages(10, 0, "b.test")).pages[0]?.url, "https://b.test/two");
    assert.equal((await service.getSitemap("b.test")).sitemapUrl, "https://b.test/sitemap.xml");
    assert.equal((await service.listPages(10)).pages[0]?.url, "https://a.test/one");
  });
});

void test("robots.txt rules are per site and never leak across sites", async () => {
  await withService(async ({ service }) => {
    // a.test disallows /secret, b.test disallows /shared; each site sees only its own rules.
    assert.ok(await service.getPage("/shared"));
    await assert.rejects(() => service.getPage("/shared", { site: "b.test" }), RobotsDisallowedError);
    assert.ok((await service.getPage("/two", { site: "b.test" })).markdown.includes("Bravo"));
    await assert.rejects(() => service.getPage("/secret", { site: "a.test" }), RobotsDisallowedError);
  });
});

void test("cache, search and refresh time stay separate per site", async () => {
  await withService(async ({ service }) => {
    await service.refresh(10);
    await service.refresh(10, false, 0, "b.test");
    assert.deepEqual((await service.search("Alpha", 10)).map((hit) => hit.url), ["https://a.test/one"]);
    assert.deepEqual((await service.search("Bravo", 10)).map((hit) => hit.url), [], "base site search must not see b.test pages");
    assert.deepEqual((await service.search("Bravo", 10, "b.test")).map((hit) => hit.url), ["https://b.test/two"]);
    assert.deepEqual((await service.search("Alpha", 10, "b.test")).map((hit) => hit.url), []);
    assert.ok(service.lastRefreshAtFor("b.test"));
  });
  await withService(async ({ service }) => {
    await service.refresh(10);
    assert.equal(service.lastRefreshAtFor("b.test"), null, "refreshing one site must not mark another as refreshed");
  });
});

void test("the fetcher paces each host independently", async () => {
  const original = globalThis.fetch;
  const starts: { host: string; at: number }[] = [];
  globalThis.fetch = ((url: string) => {
    starts.push({ host: new URL(url).host, at: Date.now() });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const fetcher = new Fetcher({ timeoutMs: 5_000, minIntervalMs: 200, maxBytes: 10_000, maxRetries: 0, userAgent: "t" });
    await fetcher.fetch("https://a.test/1");
    await fetcher.fetch("https://b.test/1");
    await fetcher.fetch("https://a.test/2");
    const [a1, b1, a2] = starts;
    assert.ok(a1 && b1 && a2);
    assert.ok(b1.at - a1.at < 150, "a different host is not held back by another host's interval");
    assert.ok(a2.at - a1.at >= 190, "the same host is still spaced by the minimum interval");
  } finally {
    globalThis.fetch = original;
  }
});

void test("a redirect to a non-allowlisted host is refused and never reaches the network", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(url);
    return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }));
  }) as unknown as typeof fetch;
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://a.test", SITE_ALLOWLIST: "b.test", FETCH_ALLOW_PRIVATE_NETWORK: "true", FETCH_MIN_INTERVAL_MS: "0" } as NodeJS.ProcessEnv);
    const { fetcher } = createRuntime(config);
    await assert.rejects(() => fetcher.fetch("https://a.test/go"), /outside the configured host allowlist/u);
    assert.deepEqual(calls, ["https://a.test/go"]);
  } finally {
    globalThis.fetch = original;
  }
});

void test("a redirect from one allowlisted site to another is refused, so robots rules of the target are never skipped", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(url);
    return Promise.resolve(new Response(null, { status: 301, headers: { location: "https://b.test/shared" } }));
  }) as unknown as typeof fetch;
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://a.test", SITE_ALLOWLIST: "b.test", FETCH_ALLOW_PRIVATE_NETWORK: "true", FETCH_MIN_INTERVAL_MS: "0" } as NodeJS.ProcessEnv);
    const { fetcher } = createRuntime(config);
    await assert.rejects(() => fetcher.fetch("https://a.test/go"), /different site/u);
    assert.deepEqual(calls, ["https://a.test/go"]);
  } finally {
    globalThis.fetch = original;
  }
});

void test("a www to apex redirect on the same site is still followed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) =>
    Promise.resolve(url.startsWith("https://www.a.test")
      ? new Response(null, { status: 301, headers: { location: "https://a.test/" } })
      : new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://a.test", FETCH_ALLOW_PRIVATE_NETWORK: "true", FETCH_MIN_INTERVAL_MS: "0" } as NodeJS.ProcessEnv);
    const { fetcher } = createRuntime(config);
    const record = await fetcher.fetch("https://www.a.test/");
    assert.equal(record.status, 200);
    assert.equal(record.finalUrl, "https://a.test/");
  } finally {
    globalThis.fetch = original;
  }
});
