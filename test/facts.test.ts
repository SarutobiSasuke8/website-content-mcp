import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { extractFacts } from "../src/facts.js";

const fixture = (name: string) => readFile(path.resolve("tests/fixtures", name), "utf8");

void test("pricing page facts: head data, outline, calls to action and schema", async () => {
  const facts = extractFacts(await fixture("pricing.html"), "https://acme.test/pricing");
  assert.equal(facts.title, "Pricing | Acme Analytics");
  assert.equal(facts.metaDescription, "Simple pricing for teams of every size.");
  assert.equal(facts.canonicalUrl, "https://acme.test/pricing");
  assert.deepEqual(facts.outline, [
    { level: 1, text: "Plans and pricing" },
    { level: 2, text: "Choose a plan" },
    { level: 3, text: "Starter" },
    { level: 3, text: "Pro" },
    { level: 3, text: "Enterprise" },
  ]);
  assert.deepEqual(facts.callsToAction, [
    { text: "Start free trial", href: "https://acme.test/signup?plan=trial" },
    { text: "Choose Starter", href: "https://acme.test/signup?plan=starter" },
    { text: "Choose Pro", href: "https://acme.test/signup?plan=pro" },
    { text: "Talk to sales" },
  ]);
  assert.deepEqual(facts.schemaTypes, ["Organization", "Product"]);
  assert.equal(facts.products?.[0]?.offers[0]?.price, "99");
  assert.equal(facts.products?.[0]?.offers[0]?.priceCurrency, "EUR");
});

void test("pricing page facts: amounts carry their plan and billing period, and scripts are never read", async () => {
  const facts = extractFacts(await fixture("pricing.html"), "https://acme.test/pricing");
  const amounts = facts.pricing?.amounts ?? [];
  const starter = amounts.find((signal) => signal.amount === "€49");
  const pro = amounts.find((signal) => signal.amount === "€99");
  assert.equal(starter?.plan, "Starter");
  assert.equal(starter?.period, "month");
  assert.equal(pro?.plan, "Pro");
  assert.equal(pro?.period, "month");
  assert.ok(amounts.some((signal) => signal.amount === "€500" && /one-off/iu.test(signal.label)));
  assert.equal(amounts.some((signal) => signal.amount === "€1"), false, "script text must not produce prices");
  assert.ok(facts.pricing?.phrases?.includes("contact sales"));
  assert.ok(facts.pricing?.phrases?.includes("free trial"));
  assert.ok(facts.pricing?.phrases?.includes("custom pricing"));
  // The enterprise card states no amount, so no price is invented for it.
  assert.equal(amounts.some((signal) => signal.plan === "Enterprise"), false);
});

void test("calls to action skip reset buttons, script links and long text", async () => {
  const facts = extractFacts(await fixture("pricing.html"), "https://acme.test/pricing");
  const texts = facts.callsToAction?.map((cta) => cta.text) ?? [];
  assert.equal(texts.includes("Reset"), false);
  assert.equal(texts.includes("Do not follow"), false);
  assert.equal(texts.includes("Privacy policy"), false, "plain links are not prominent calls to action");
});

void test("index page facts list dated entries and omit dates that are not stated", async () => {
  const facts = extractFacts(await fixture("blog-index.html"), "https://example.test/insights");
  assert.deepEqual(facts.items, [
    { title: "Third post about pricing", href: "https://example.test/insights/third-post", date: "2026-10-30" },
    { title: "Second post", href: "https://example.test/insights/second-post", date: "2 October 2026" },
    { title: "An undated entry", href: "https://other.example/news" },
  ]);
  assert.equal(facts.pricing, undefined);
  assert.equal(facts.products, undefined);
  assert.equal(facts.canonicalUrl, undefined, "no canonical is invented");
});

void test("a single article is not treated as an index", () => {
  const facts = extractFacts(
    '<html><head><title>One</title></head><body><article><h1><a href="/one">One</a></h1><time datetime="2026-01-01">1 January 2026</time></article></body></html>',
    "https://example.test/one",
  );
  assert.equal(facts.items, undefined);
});

void test("facts degrade gracefully on a client-rendered shell with broken JSON-LD", async () => {
  const facts = extractFacts(await fixture("bare-shell.html"), "https://shell.test/");
  assert.deepEqual(facts, {});
});

void test("facts degrade gracefully on garbage input and never throw", () => {
  assert.doesNotThrow(() => extractFacts("", "https://x.test/"));
  assert.doesNotThrow(() => extractFacts("<<<>>><div", "https://x.test/"));
  assert.deepEqual(extractFacts("plain text, no markup", "https://x.test/"), {});
});

void test("facts are bounded", () => {
  const rows = Array.from({ length: 200 }, (_, i) => `<h2>Heading ${i}</h2><p>Item costs €${i + 1}</p><a class="btn" href="/go/${i}">Go ${i}</a>`).join("");
  const facts = extractFacts(`<html><body>${rows}</body></html>`, "https://x.test/");
  assert.ok((facts.outline?.length ?? 0) <= 60);
  assert.ok((facts.callsToAction?.length ?? 0) <= 25);
  assert.ok((facts.pricing?.amounts.length ?? 0) <= 40);
});

void test("facts are identical across runs", async () => {
  const html = await fixture("pricing.html");
  assert.deepEqual(extractFacts(html, "https://acme.test/pricing"), extractFacts(html, "https://acme.test/pricing"));
});
