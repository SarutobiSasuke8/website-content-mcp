import { createHash } from "node:crypto";

import { normalizeHost } from "./config.js";
import { htmlToMarkdown } from "./content.js";
import { isPathAllowed, parseRobots } from "./robots.js";
import { parseSitemap } from "./sitemap.js";

import type { DiskCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import type { ConditionalHeaders, Fetcher } from "./fetcher.js";
import type { RobotsRules } from "./robots.js";
import type {
  ExtractedContent,
  FetchRecord,
  HealthStatus,
  PageContent,
  PageListing,
  RefreshResult,
  SearchHit,
  SitemapEntry,
} from "./types.js";

const MAX_NESTED_SITEMAPS = 5;
const MAX_REFRESH_ERRORS = 20;
const EMPTY_ROBOTS: RobotsRules = { disallow: [], allow: [], sitemaps: [] };

export class RobotsDisallowedError extends Error {
  public constructor(url: string) {
    super(`Fetching '${url}' is disallowed by the site's robots.txt.`);
    this.name = "RobotsDisallowedError";
  }
}

export class HostNotAllowedError extends Error {
  public constructor(url: string, allowedHosts: string[]) {
    super(`Refusing to fetch '${url}': host is not in the allowed list (${allowedHosts.join(", ")}).`);
    this.name = "HostNotAllowedError";
  }
}

/**
 * Core content service. Ties together the rate-limited fetcher, the disk cache,
 * robots enforcement, sitemap discovery and HTML→markdown extraction.
 */
export class ContentService {
  /** robots.txt rules, cached per origin. */
  private readonly robotsByOrigin = new Map<string, RobotsRules>();

  public constructor(
    private readonly config: AppConfig,
    private readonly cache: DiskCache,
    private readonly fetcher: Fetcher,
  ) {}

  /**
   * Resolve a reference against the base URL and confirm the result is a
   * fetchable http(s) URL on an allowed host.
   */
  public resolveAllowed(rawUrl: string): string {
    let url: URL;
    try {
      url = new URL(rawUrl, this.config.baseUrl);
    } catch {
      throw new Error(`'${rawUrl}' is not a valid URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new HostNotAllowedError(url.toString(), this.config.allowedHosts);
    }
    if (!this.config.allowedHosts.includes(normalizeHost(url.host))) {
      throw new HostNotAllowedError(url.toString(), this.config.allowedHosts);
    }
    return url.toString();
  }

  private isAllowedHost(rawUrl: string): boolean {
    try {
      this.resolveAllowed(rawUrl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load a URL, preferring a fresh cache entry, then a conditional revalidation
   * of a stale entry, then a plain fetch. A failed fetch falls back to any
   * stale copy rather than erroring.
   */
  private async load(url: string, force = false): Promise<{ record: FetchRecord; fromCache: boolean }> {
    const stale = await this.cache.read(url);
    if (!force && stale && this.cache.isFresh(stale)) return { record: stale, fromCache: true };

    const conditional: ConditionalHeaders = {};
    if (stale?.etag) conditional.etag = stale.etag;
    if (stale?.lastModified) conditional.lastModified = stale.lastModified;

    try {
      const fetched = await this.fetcher.fetch(url, conditional);
      if (fetched.status === 304 && stale) {
        // Unchanged upstream: keep the body (and its extraction), reset the clock.
        const revalidated: FetchRecord = { ...stale, fetchedAt: fetched.fetchedAt };
        await this.cache.set(revalidated);
        return { record: revalidated, fromCache: true };
      }
      await this.cache.set(fetched);
      return { record: fetched, fromCache: false };
    } catch (error) {
      if (stale) return { record: stale, fromCache: true };
      throw error;
    }
  }

  /**
   * Markdown for a record, computed once and written back to the cache so
   * search never re-parses the same HTML.
   */
  private async extractionOf(record: FetchRecord): Promise<ExtractedContent> {
    if (record.extracted) return record.extracted;
    const extracted = htmlToMarkdown(record.body, record.url);
    await this.cache.set({ ...record, extracted });
    return extracted;
  }

  private async getRobots(origin: string): Promise<RobotsRules> {
    const cached = this.robotsByOrigin.get(origin);
    if (cached) return cached;

    const robotsUrl = new URL("/robots.txt", origin).toString();
    let rules: RobotsRules = EMPTY_ROBOTS;
    try {
      const { record } = await this.load(robotsUrl);
      if (record.status >= 200 && record.status < 300) rules = parseRobots(record.body);
    } catch {
      rules = EMPTY_ROBOTS;
    }
    this.robotsByOrigin.set(origin, rules);
    return rules;
  }

  /** Whether robots.txt for the URL's own origin permits fetching it. */
  private async isRobotsAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const rules = await this.getRobots(parsed.origin);
    return isPathAllowed(rules, parsed.pathname + parsed.search);
  }

  private async assertAllowed(url: string): Promise<void> {
    if (!(await this.isRobotsAllowed(url))) throw new RobotsDisallowedError(url);
  }

  public async getPage(
    rawUrl: string,
    options: { maxLength?: number; refresh?: boolean } = {},
  ): Promise<PageContent> {
    const url = this.resolveAllowed(rawUrl);
    await this.assertAllowed(url);
    const { record, fromCache } = await this.load(url, options.refresh ?? false);
    if (record.status >= 400) throw new Error(`Fetch failed for '${url}' with HTTP ${record.status}.`);

    const extracted = await this.extractionOf(record);
    const full = extracted.markdown;
    const limit = options.maxLength;
    const truncated = limit !== undefined && limit > 0 && full.length > limit;
    const markdown = truncated ? full.slice(0, limit) : full;

    const content: PageContent = {
      url,
      markdown,
      contentHash: createHash("sha256").update(full).digest("hex"),
      contentLength: full.length,
      truncated,
      fetchedAt: record.fetchedAt,
      fromCache,
    };
    if (record.finalUrl) content.finalUrl = record.finalUrl;
    if (record.etag) content.etag = record.etag;
    if (record.lastModified) content.lastModified = record.lastModified;
    if (extracted.title) content.title = extracted.title;
    if (extracted.canonicalUrl) content.canonicalUrl = extracted.canonicalUrl;
    if (extracted.products) content.products = extracted.products;
    return content;
  }

  /** Fetch and parse a sitemap, following one level of sitemap-index nesting. */
  private async loadSitemapEntries(sitemapUrl: string): Promise<SitemapEntry[]> {
    if (!this.isAllowedHost(sitemapUrl)) return [];
    const { record } = await this.load(sitemapUrl);
    if (record.status >= 400 || !record.body.trim()) return [];
    const parsed = parseSitemap(record.body);
    if (parsed.entries.length > 0) return parsed.entries;

    const entries: SitemapEntry[] = [];
    for (const nested of parsed.sitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
      if (!this.isAllowedHost(nested)) continue;
      const { record: nestedRecord } = await this.load(nested);
      if (nestedRecord.status < 400 && nestedRecord.body.trim()) {
        entries.push(...parseSitemap(nestedRecord.body).entries);
      }
    }
    return entries;
  }

  public async getSitemap(): Promise<{ sitemapUrl: string; available: boolean; entries: SitemapEntry[] }> {
    const entries = await this.loadSitemapEntries(this.config.sitemapUrl);
    return { sitemapUrl: this.config.sitemapUrl, available: entries.length > 0, entries };
  }

  public async listPages(limit: number): Promise<{ source: PageListing["source"]; pages: PageListing[] }> {
    // 1. Configured sitemap.
    const sitemapEntries = await this.loadSitemapEntries(this.config.sitemapUrl);
    if (sitemapEntries.length > 0) {
      return { source: "sitemap", pages: sitemapEntries.slice(0, limit).map((entry) => toListing(entry, "sitemap")) };
    }

    // 2. Sitemaps advertised in robots.txt.
    const robots = await this.getRobots(new URL(this.config.baseUrl).origin);
    for (const sitemap of robots.sitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
      const entries = await this.loadSitemapEntries(sitemap);
      if (entries.length > 0) {
        return { source: "robots", pages: entries.slice(0, limit).map((entry) => toListing(entry, "robots")) };
      }
    }

    // 3. Configured page list (defaulting to the base URL).
    const configured = this.config.configuredPages.length > 0 ? this.config.configuredPages : [this.config.baseUrl];
    return {
      source: "configured",
      pages: configured.slice(0, limit).map((url) => ({ url, source: "configured" as const })),
    };
  }

  /**
   * Warm the cache by walking the site's discoverable pages, so `search` has
   * something to search. Robots-disallowed and off-host URLs are skipped.
   */
  public async refresh(limit: number, force = false): Promise<RefreshResult> {
    const { source, pages } = await this.listPages(limit);
    const result: RefreshResult = {
      source,
      requested: pages.length,
      fetched: 0,
      revalidated: 0,
      skipped: 0,
      failed: [],
    };

    for (const page of pages) {
      try {
        const url = this.resolveAllowed(page.url);
        if (!(await this.isRobotsAllowed(url))) {
          result.skipped += 1;
          continue;
        }
        const { record, fromCache } = await this.load(url, force);
        if (record.status >= 400) {
          if (result.failed.length < MAX_REFRESH_ERRORS) {
            result.failed.push({ url, reason: `HTTP ${record.status}` });
          }
          continue;
        }
        if (isHtml(record)) await this.extractionOf(record);
        if (fromCache) result.revalidated += 1;
        else result.fetched += 1;
      } catch (error) {
        if (result.failed.length < MAX_REFRESH_ERRORS) {
          result.failed.push({ url: page.url, reason: error instanceof Error ? error.message : "unknown error" });
        }
      }
    }

    return result;
  }

  public async search(query: string, limit: number): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const records = await this.cache.all();
    const hits: SearchHit[] = [];

    for (const record of records) {
      if (record.status >= 400) continue;
      if (!record.extracted && !isHtml(record)) continue;

      const extracted = await this.extractionOf(record);
      const haystack = `${extracted.title ?? ""}\n${extracted.markdown}`;
      const lower = haystack.toLowerCase();
      const first = lower.indexOf(needle);
      if (first === -1) continue;

      const score = lower.split(needle).length - 1;
      const start = Math.max(0, first - 80);
      const end = Math.min(haystack.length, first + needle.length + 80);
      const snippet = `${start > 0 ? "…" : ""}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${end < haystack.length ? "…" : ""}`;
      const hit: SearchHit = { url: record.url, score, snippet };
      if (extracted.title) hit.title = extracted.title;
      hits.push(hit);
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public async health(): Promise<HealthStatus> {
    const stats = await this.cache.stats();
    const status: HealthStatus = {
      status: "ok",
      baseUrl: this.config.baseUrl,
      allowedHosts: this.config.allowedHosts,
      sitemapUrl: this.config.sitemapUrl,
      configuredPages: this.config.configuredPages.length,
      cacheDir: this.config.cacheDir,
      cacheTtlSeconds: this.config.cacheTtlSeconds,
      cacheMaxEntries: this.config.cacheMaxEntries,
      cacheEntries: stats.entries,
      cacheBytes: stats.bytes,
    };
    if (stats.lastFetchAt) status.lastFetchAt = stats.lastFetchAt;
    return status;
  }
}

/**
 * Whether a cached record looks like a page worth extracting. Sitemaps and
 * other XML land in the same cache, and must not be searched as if they were
 * articles.
 */
function isHtml(record: FetchRecord): boolean {
  const type = record.contentType?.toLowerCase() ?? "";
  if (type.includes("html")) return true;
  if (type) return false;

  // No content-type header: sniff, excluding XML prologs and sitemap roots.
  const head = record.body.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<?xml") || head.includes("<urlset") || head.includes("<sitemapindex")) return false;
  return head.startsWith("<");
}

function toListing(entry: SitemapEntry, source: PageListing["source"]): PageListing {
  const listing: PageListing = { url: entry.url, source };
  if (entry.lastModified) listing.lastModified = entry.lastModified;
  if (entry.priority !== undefined) listing.priority = entry.priority;
  return listing;
}
