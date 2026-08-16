import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { htmlToMarkdown } from "../src/content.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/sample.html");

void test("htmlToMarkdown extracts the main article as clean markdown", async () => {
  const html = await readFile(fixture, "utf8");
  const result = htmlToMarkdown(html, "https://example.com/articles/sample");

  assert.match(result.markdown, /main body/u);
  assert.match(result.markdown, /First key point about extraction/u);
  assert.match(result.markdown, /Second key point about caching/u);
  assert.equal(result.canonicalUrl, "https://example.com/articles/sample");
  assert.ok(result.title && result.title.length > 0);
});

void test("htmlToMarkdown never leaks scripts, styles, or footer chrome", async () => {
  const html = await readFile(fixture, "utf8");
  const result = htmlToMarkdown(html, "https://example.com/articles/sample");

  assert.doesNotMatch(result.markdown, /console\.log/u);
  assert.doesNotMatch(result.markdown, /window\.analytics/u);
  assert.doesNotMatch(result.markdown, /\.hidden \{/u);
  assert.doesNotMatch(result.markdown, /Copyright notice/u);
});

void test("htmlToMarkdown falls back to body stripping for tiny pages", () => {
  const html = "<html><body><nav>SkipNav</nav><p>Hello world content.</p><script>doBadThings()</script></body></html>";
  const result = htmlToMarkdown(html);

  assert.match(result.markdown, /Hello world content\./u);
  assert.doesNotMatch(result.markdown, /doBadThings/u);
  assert.doesNotMatch(result.markdown, /SkipNav/u);
});

void test("htmlToMarkdown converts links and lists to markdown syntax", async () => {
  const html = await readFile(fixture, "utf8");
  const result = htmlToMarkdown(html, "https://example.com/articles/sample");

  assert.match(result.markdown, /\[the documentation\]\(https:\/\/example\.com\/docs\)/u);
  assert.match(result.markdown, /^- /mu);
});

void test("htmlToMarkdown extracts bounded schema.org Product and Offer facts", () => {
  const html = `<html><head><title>Shop</title>
    <script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Product","name":"Blue Widget",
      "sku":"BW-1","gtin13":"1234567890123","brand":{"@type":"Brand","name":"Widget Co"},
      "offers":{"@type":"Offer","price":"19.99","priceCurrency":"EUR","availability":"https://schema.org/InStock"}
    }</script></head><body><main><h1>Blue Widget</h1><p>A useful blue widget.</p></main></body></html>`;
  const result = htmlToMarkdown(html, "https://shop.test/blue-widget");

  assert.equal(result.products?.length, 1);
  assert.equal(result.products?.[0]?.name, "Blue Widget");
  assert.equal(result.products?.[0]?.sku, "BW-1");
  assert.equal(result.products?.[0]?.gtin, "1234567890123");
  assert.equal(result.products?.[0]?.brand, "Widget Co");
  assert.deepEqual(result.products?.[0]?.offers[0], {
    price: "19.99",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
  });
  assert.doesNotMatch(result.markdown, /priceCurrency/u, "JSON-LD must not leak into markdown");
});

void test("structured commerce extraction bounds field length and JSON-LD recursion", () => {
  const longName = "x".repeat(3_000);
  let nested: Record<string, unknown> = { "@type": "Product", name: "too deep" };
  for (let depth = 0; depth < 20; depth += 1) nested = { "@graph": [nested] };
  const html = `<html><head><script type="application/ld+json">${JSON.stringify([
    { "@type": "Product", name: longName },
    nested,
  ])}</script></head><body><p>Shop content.</p></body></html>`;

  const result = htmlToMarkdown(html);
  assert.equal(result.products?.length, 1, "a product beyond the recursion cap is ignored");
  assert.equal(result.products?.[0]?.name?.length, 2_048);
});
