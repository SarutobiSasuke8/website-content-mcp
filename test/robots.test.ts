import assert from "node:assert/strict";
import test from "node:test";

import { isPathAllowed, parseRobots } from "../src/robots.js";

const sample = `
# Example robots
User-agent: *
Disallow: /private
Disallow: /tmp/
Allow: /private/public-note
Sitemap: https://example.com/sitemap.xml

User-agent: BadBot
Disallow: /
`;

void test("parseRobots collects star-group rules and sitemaps", () => {
  const rules = parseRobots(sample);
  assert.deepEqual(rules.disallow.sort(), ["/private", "/tmp/"]);
  assert.deepEqual(rules.allow, ["/private/public-note"]);
  assert.deepEqual(rules.sitemaps, ["https://example.com/sitemap.xml"]);
});

void test("isPathAllowed blocks disallowed paths and honors allow overrides", () => {
  const rules = parseRobots(sample);
  assert.equal(isPathAllowed(rules, "/"), true);
  assert.equal(isPathAllowed(rules, "/articles/hello"), true);
  assert.equal(isPathAllowed(rules, "/private"), false);
  assert.equal(isPathAllowed(rules, "/private/secret"), false);
  assert.equal(isPathAllowed(rules, "/private/public-note"), true, "longer allow beats disallow");
  assert.equal(isPathAllowed(rules, "/tmp/file"), false);
});

void test("empty or missing rules allow everything", () => {
  assert.equal(isPathAllowed(parseRobots(""), "/anything"), true);
});

void test("wildcard and end-anchor rules are respected", () => {
  const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\n");
  assert.equal(isPathAllowed(rules, "/docs/report.pdf"), false);
  assert.equal(isPathAllowed(rules, "/docs/report.pdf?x=1"), true, "anchored rule requires end of path");
  assert.equal(isPathAllowed(rules, "/docs/report.html"), true);
});
