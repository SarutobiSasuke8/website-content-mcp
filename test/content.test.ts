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
