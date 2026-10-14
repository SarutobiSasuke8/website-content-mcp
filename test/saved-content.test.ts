import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { htmlToMarkdown } from "../src/content.js";
import type { Fetcher } from "../src/fetcher.js";
import { ContentService } from "../src/service.js";

const fixture = (name: string) => readFile(path.resolve("tests/fixtures", name), "utf8");

void test("saved article retains semantic formatting and resolves relative links", async () => {
  const result = htmlToMarkdown(await fixture("article.html"), "https://fixture.test/guides/field-notes");
  assert.equal(result.extractionQuality, "full");
  assert.equal(result.canonicalUrl, "https://fixture.test/guides/field-notes");
  assert.match(result.markdown, /^## Read & verify$/mu);
  assert.match(result.markdown, /\[setup guide\]\(https:\/\/fixture\.test\/docs\/setup\?mode=local&step=1\)/u);
  assert.match(result.markdown, /^-\s+Save the source$/mu);
  assert.match(result.markdown, /café notes/u);
  assert.match(result.markdown, /```[\s\S]*const message = "<ready>";[\s\S]*```/u);
});

void test("saved article never executes scripts or requests external resources", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  try {
    const result = htmlToMarkdown(await fixture("article.html"), "https://fixture.test/");
    assert.doesNotMatch(result.markdown, /NavigationOnly|SidebarOnly|FooterOnly|trackingOnly/u);
  } finally { globalThis.fetch = originalFetch; }
});

void test("saved client shell is labelled metadata-only with its OpenGraph summary", async () => {
  const result = htmlToMarkdown(await fixture("client-shell.html"), "https://fixture.test/app");
  assert.equal(result.extractionMethod, "metadata");
  assert.equal(result.extractionQuality, "metadata-only");
  assert.equal(result.markdown, "# Local shell\n\nThis application needs client rendering.");
  assert.match(result.warnings?.[0] ?? "", /client-side rendering/u);
});

void test("one malformed JSON-LD block does not discard the saved product or body", async () => {
  const result = htmlToMarkdown(await fixture("commerce.html"), "https://fixture.test/shop");
  assert.match(result.markdown, /Fixture lamp/u);
  assert.doesNotMatch(result.markdown, /invalid-json|offerCount|@graph/u);
  assert.equal(result.products?.length, 1);
  assert.equal(result.products?.[0]?.sku, "FL-1");
  assert.equal(result.products?.[0]?.offers[0]?.priceCurrency, "EUR");
  assert.equal(result.products?.[0]?.offers[1]?.lowPrice, "10");
});

void test("empty HTML produces an explicit empty result, not invented content", () => {
  const result = htmlToMarkdown("<html><body></body></html>");
  assert.equal(result.markdown, "");
  assert.equal(result.extractionMethod, "empty");
  assert.equal(result.extractionQuality, "empty");
  assert.ok(result.warnings?.length);
});

void test("saved extraction is deterministic across repeated parses", async () => {
  const html = await fixture("article.html");
  assert.deepEqual(htmlToMarkdown(html, "https://fixture.test/"), htmlToMarkdown(html, "https://fixture.test/"));
});

void test("service formatting hashes full fixture content before response truncation and reuses the cache", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-saved-"));
  const html = await fixture("article.html");
  const calls: string[] = [];
  const fetcher = {
    async fetch(url: string) {
      calls.push(url);
      assert.ok(["https://fixture.test/robots.txt", "https://fixture.test/guides/field-notes"].includes(url));
      return { url, status: 200, body: url.endsWith("robots.txt") ? "User-agent: *\nAllow: /\n" : html, contentType: url.endsWith("robots.txt") ? "text/plain" : "text/html", fetchedAt: new Date().toISOString() };
    },
  };
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://fixture.test", CACHE_DIR: dir } as NodeJS.ProcessEnv);
    const service = new ContentService(config, new DiskCache(dir, config.cacheTtlSeconds, config.cacheMaxEntries), fetcher as unknown as Fetcher);
    const full = await service.getPage("/guides/field-notes");
    const limited = await service.getPage("/guides/field-notes", { maxLength: 100 });
    assert.equal(full.contentHash, createHash("sha256").update(full.markdown).digest("hex"));
    assert.equal(limited.contentHash, full.contentHash);
    assert.equal(limited.contentLength, full.markdown.length);
    assert.equal(limited.markdown, full.markdown.slice(0, 100));
    assert.equal(limited.truncated, true);
    assert.equal(limited.fromCache, true);
    assert.equal(limited.sourceTrust, "untrusted-web-content");
    assert.equal(calls.filter(url => !url.endsWith("robots.txt")).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
