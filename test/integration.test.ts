import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

/**
 * Live integration test against a real public site (https://example.com).
 * Exercises the full path: health → list_pages → get_page → search.
 *
 * example.com has no sitemap.xml/robots.txt, so it also verifies the
 * "configured page list" discovery fallback.
 *
 * Opt-in. This test reaches the real network, so it is skipped by default and
 * in CI: a third-party outage is not a defect in this server. Run it with
 * RUN_LIVE_TESTS=1 when you want end-to-end confirmation against a live site.
 */
void test("live integration against example.com", {
  timeout: 30_000,
  skip: process.env.RUN_LIVE_TESTS === "1" ? false : "set RUN_LIVE_TESTS=1 to run",
}, async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wcm-int-"));
  try {
    const config = loadConfig({
      SITE_BASE_URL: "https://example.com",
      CACHE_DIR: cacheDir,
      FETCH_MIN_INTERVAL_MS: "0",
    } as NodeJS.ProcessEnv);
    const { service } = createRuntime(config);

    const health = await service.health();
    console.log("HEALTH:", JSON.stringify(health, null, 2));
    assert.equal(health.status, "ok");
    assert.equal(health.baseUrl, "https://example.com/");
    assert.equal(health.cacheEntries, 0);

    const list = await service.listPages(50);
    console.log("LIST_PAGES:", JSON.stringify(list, null, 2));
    assert.equal(list.source, "configured");
    assert.ok(list.pages.length >= 1);
    assert.equal(list.pages[0]?.url, "https://example.com/");

    const page = await service.getPage("https://example.com/");
    console.log("GET_PAGE:", JSON.stringify({ ...page, markdown: page.markdown.slice(0, 400) }, null, 2));
    assert.equal(page.url, "https://example.com/");
    assert.match(page.title ?? "", /Example Domain/u);
    assert.match(page.markdown, /examples/iu);
    assert.ok(page.contentLength > 0);

    const results = await service.search("domain", 10);
    console.log("SEARCH:", JSON.stringify(results, null, 2));
    assert.ok(results.length >= 1);
    assert.equal(results[0]?.url, "https://example.com/");
    assert.ok(results[0]?.score >= 1);

    const healthAfter = await service.health();
    console.log("HEALTH_AFTER:", JSON.stringify(healthAfter, null, 2));
    assert.ok(healthAfter.cacheEntries >= 1);
    assert.ok(healthAfter.lastFetchAt);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
