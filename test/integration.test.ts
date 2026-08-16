import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

/** Opt-in live checks. Set LIVE_SITE_URLS to a comma-separated deployment set. */
void test("live integration against configured public sites", {
  timeout: 30_000,
  skip: process.env.RUN_LIVE_TESTS === "1" ? false : "set RUN_LIVE_TESTS=1 to run",
}, async () => {
  const sites = (process.env.LIVE_SITE_URLS ?? "https://example.com")
    .split(",")
    .map((site) => site.trim())
    .filter(Boolean);

  for (const site of sites) {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wcm-int-"));
    try {
      const baseUrl = new URL(site).toString();
      const config = loadConfig({
        SITE_BASE_URL: baseUrl,
        CACHE_DIR: cacheDir,
        FETCH_MIN_INTERVAL_MS: "0",
      } as NodeJS.ProcessEnv);
      const { service } = createRuntime(config);

      const health = await service.health();
      console.log("HEALTH:", JSON.stringify(health, null, 2));
      assert.equal(health.status, "ok");
      assert.equal(health.baseUrl, baseUrl);
      assert.equal(health.cacheEntries, 0);

      const list = await service.listPages(50);
      console.log("LIST_PAGES:", JSON.stringify({ site: baseUrl, source: list.source, count: list.pages.length }, null, 2));
      assert.ok(list.pages.length >= 1);

      const firstUrl = list.pages[0]?.url;
      assert.ok(firstUrl);
      const page = await service.getPage(firstUrl);
      console.log("GET_PAGE:", JSON.stringify({ ...page, markdown: page.markdown.slice(0, 400) }, null, 2));
      assert.ok(page.contentLength > 0);
      assert.match(page.contentHash, /^[a-f0-9]{64}$/u);

      const query = page.title?.split(/\s+/u).find((word) => word.length >= 4)
        ?? page.markdown.split(/\s+/u).find((word) => word.length >= 4)
        ?? "content";
      const results = await service.search(query, 10);
      console.log("SEARCH:", JSON.stringify({ site: baseUrl, query, count: results.length }, null, 2));
      assert.ok(results.length >= 1);

      const healthAfter = await service.health();
      assert.ok(healthAfter.cacheEntries >= 1);
      assert.ok(healthAfter.lastFetchAt);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
});
