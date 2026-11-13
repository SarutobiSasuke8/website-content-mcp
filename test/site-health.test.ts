import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DiskCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { ContentService } from "../src/service.js";
import { auditHtml, comparableUrl, pageFindings } from "../src/site-health.js";

import type { Fetcher } from "../src/fetcher.js";
import type { FetchRecord } from "../src/types.js";

const html = (opts: { title?: string; description?: boolean; canonical?: string; jsonld?: boolean; h1?: number; links?: string[] }) => `<html><head>
${opts.title !== undefined ? `<title>${opts.title}</title>` : ""}
${opts.description === false ? "" : '<meta name="description" content="A description.">'}
${opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : ""}
${opts.jsonld === false ? "" : '<script type="application/ld+json">{"@type":"WebPage"}</script>'}
</head><body>${"<h1>Heading</h1>".repeat(opts.h1 ?? 1)}<p>Body text.</p>
${(opts.links ?? []).map((href) => `<a href="${href}">link</a>`).join("")}</body></html>`;

void test("auditHtml reads the head, headings and same-site links only", () => {
  const audit = auditHtml(
    html({ title: "Home", canonical: "https://a.test/", links: ["/about", "https://a.test/pricing#plans", "https://other.test/x", "mailto:a@a.test", "#top", "/logo.png", "https://www.a.test/contact"] }),
    "https://a.test/",
    "a.test",
  );
  assert.equal(audit.title, "Home");
  assert.equal(audit.h1Count, 1);
  assert.equal(audit.hasJsonLd, true);
  assert.deepEqual(audit.internalLinks, ["https://a.test/about", "https://a.test/pricing", "https://www.a.test/contact"]);
});

void test("pageFindings ranks each problem and treats www and trailing slash as the same canonical", () => {
  const bad = pageFindings("https://a.test/x", auditHtml(html({ h1: 2, description: false, jsonld: false, canonical: "https://a.test/y" }), "https://a.test/x", "a.test"));
  const byCheck = Object.fromEntries(bad.map((finding) => [finding.check, finding.severity]));
  assert.deepEqual(byCheck, {
    "missing-title": "high",
    "multiple-h1": "medium",
    "missing-meta-description": "medium",
    "canonical-not-self": "high",
    "missing-json-ld": "low",
  });
  const fine = pageFindings("https://a.test/x/", auditHtml(html({ title: "T", canonical: "https://www.a.test/x" }), "https://a.test/x/", "a.test"));
  assert.deepEqual(fine, []);
  assert.equal(comparableUrl("http://www.a.test/x/?q=1#h"), comparableUrl("https://a.test/x"));
});

const sitemap = (...urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

type Route = { status: number; body: string; contentType?: string; finalUrl?: string };

class SiteFetcher {
  public readonly urls: string[] = [];
  public constructor(private readonly routes: Record<string, Route>) {}
  public fetch(url: string): Promise<FetchRecord> {
    this.urls.push(url);
    const route = this.routes[url];
    if (!route) return Promise.resolve({ url, status: 404, body: "", fetchedAt: new Date().toISOString() });
    const record: FetchRecord = { url, status: route.status, body: route.body, fetchedAt: new Date().toISOString() };
    if (route.contentType) record.contentType = route.contentType;
    if (route.finalUrl) record.finalUrl = route.finalUrl;
    return Promise.resolve(record);
  }
}

const routes = (): Record<string, Route> => ({
  "https://a.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private\n", contentType: "text/plain" },
  "https://a.test/sitemap.xml": {
    status: 200,
    contentType: "text/xml",
    body: sitemap("https://a.test/", "https://a.test/about", "https://a.test/dup", "https://a.test/gone", "https://a.test/moved"),
  },
  "https://a.test/": { status: 200, contentType: "text/html", body: html({ title: "Home", canonical: "https://a.test/", links: ["/about", "/missing", "/orphan", "/private/area", "/logo.png"] }) },
  "https://a.test/about": { status: 200, contentType: "text/html", body: html({ title: "About", canonical: "https://a.test/about", links: ["/orphan"] }) },
  "https://a.test/dup": { status: 200, contentType: "text/html", body: html({ title: "About", canonical: "https://a.test/other", h1: 0, description: false }) },
  "https://a.test/orphan": { status: 200, contentType: "text/html", body: html({ title: "Orphan", canonical: "https://a.test/orphan" }) },
  "https://a.test/moved": { status: 200, contentType: "text/html", finalUrl: "https://a.test/new-home", body: html({ title: "Moved", canonical: "https://a.test/new-home" }) },
  "https://a.test/gone": { status: 410, body: "" },
});

async function withHealth(run: (service: ContentService, fetcher: SiteFetcher) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-health-"));
  try {
    const config = loadConfig({ SITE_BASE_URL: "https://a.test", CACHE_DIR: dir, ...env } as NodeJS.ProcessEnv);
    const fetcher = new SiteFetcher(routes());
    const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
    await run(new ContentService(config, cache, fetcher as unknown as Fetcher), fetcher);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("siteHealth groups findings by severity and covers each requested check", async () => {
  await withHealth(async (service) => {
    const report = await service.siteHealth({ maxPages: 10, maxLinks: 10 });
    const checks = (severity: "critical" | "high" | "medium" | "low") => report.findings[severity].map((finding) => `${finding.check} ${finding.url}`);

    assert.deepEqual(checks("critical"), [
      "broken-internal-link https://a.test/missing",
      "sitemap-non-200 https://a.test/gone",
    ]);
    assert.ok(checks("high").includes("canonical-not-self https://a.test/dup"));
    assert.ok(checks("high").includes("missing-h1 https://a.test/dup"));
    assert.ok(checks("high").includes("duplicate-title https://a.test/about"));
    assert.ok(checks("high").includes("duplicate-title https://a.test/dup"));
    assert.ok(checks("medium").includes("missing-meta-description https://a.test/dup"));
    assert.ok(checks("medium").includes("linked-not-in-sitemap https://a.test/orphan"));
    assert.ok(checks("medium").includes("sitemap-redirect https://a.test/moved"));
    assert.deepEqual(report.findings.low, [], "every fixture page carries JSON-LD");
    assert.equal(report.summary.total, report.summary.critical + report.summary.high + report.summary.medium + report.summary.low);
    assert.equal(report.pagesChecked, 5);
    assert.equal(report.sitemapPages, 5);
    assert.equal(report.pages.find((page) => page.url === "https://a.test/gone")?.status, 410);
  });
});

void test("siteHealth never fetches robots-disallowed pages, asset links or pages beyond its budget", async () => {
  await withHealth(async (service, fetcher) => {
    const report = await service.siteHealth({ maxPages: 2, maxLinks: 0 });
    assert.ok(!fetcher.urls.includes("https://a.test/private/area"));
    assert.ok(!fetcher.urls.includes("https://a.test/logo.png"));
    assert.ok(!fetcher.urls.includes("https://a.test/dup"), "pages beyond max_pages are not fetched");
    assert.ok(!fetcher.urls.includes("https://a.test/missing"), "max_links 0 checks no extra links");
    assert.equal(report.truncated, true);
    assert.ok(report.warnings.some((warning) => warning.includes("first 2 of 5")));
  });
  await withHealth(async (service, fetcher) => {
    const report = await service.siteHealth({ maxPages: 10, maxLinks: 10 });
    assert.ok(!fetcher.urls.includes("https://a.test/private/area"));
    assert.equal(report.skippedByRobots, 1);
  });
});

void test("siteHealth respects the site argument and refuses sites that are not allowlisted", async () => {
  await withHealth(async (service, fetcher) => {
    await assert.rejects(() => service.siteHealth({ site: "evil.test" }), /allowlist/u);
    assert.equal(fetcher.urls.length, 0);
  });
});

void test("siteHealth reports an unreachable sitemap page without failing the run", async () => {
  {
    const failing = {
      fetch: (url: string) => (url === "https://a.test/about"
        ? Promise.reject(new Error("socket hang up"))
        : new SiteFetcher(routes()).fetch(url)),
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-health2-"));
    try {
      const config = loadConfig({ SITE_BASE_URL: "https://a.test", CACHE_DIR: dir } as NodeJS.ProcessEnv);
      const other = new ContentService(config, new DiskCache(dir, 0), failing as unknown as Fetcher);
      const report = await other.siteHealth({ maxPages: 5, maxLinks: 0 });
      assert.ok(report.findings.critical.some((finding) => finding.check === "sitemap-page-unreachable" && finding.url === "https://a.test/about"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
