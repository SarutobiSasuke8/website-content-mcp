import assert from "node:assert/strict";
import test from "node:test";

import { parseSitemap } from "../src/sitemap.js";

const urlset = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-01-01</lastmod>
    <priority>1.0</priority>
    <changefreq>daily</changefreq>
  </url>
  <url>
    <loc>https://example.com/about</loc>
    <priority>0.5</priority>
  </url>
</urlset>`;

const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;

void test("parseSitemap reads urlset entries with metadata", () => {
  const parsed = parseSitemap(urlset);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0]?.url, "https://example.com/");
  assert.equal(parsed.entries[0]?.lastModified, "2026-01-01");
  assert.equal(parsed.entries[0]?.priority, 1);
  assert.equal(parsed.entries[0]?.changeFrequency, "daily");
  assert.equal(parsed.entries[1]?.priority, 0.5);
  assert.equal(parsed.sitemaps.length, 0);
});

void test("parseSitemap reads sitemap index entries", () => {
  const parsed = parseSitemap(index);
  assert.equal(parsed.entries.length, 0);
  assert.deepEqual(parsed.sitemaps, [
    "https://example.com/sitemap-1.xml",
    "https://example.com/sitemap-2.xml",
  ]);
});

void test("parseSitemap tolerates malformed input", () => {
  const parsed = parseSitemap("not really xml <<<");
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.sitemaps.length, 0);
});
