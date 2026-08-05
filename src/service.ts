import { htmlToMarkdown } from "./content.js";
import { isPathAllowed, parseRobots } from "./robots.js";
import { parseSitemap } from "./sitemap.js";

import type { DiskCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import type { Fetcher } from "./fetcher.js";
import type { RobotsRules } from "./robots.js";
import type { HealthStatus, PageContent, PageListing, SearchHit, SitemapEntry } from "./types.js";

const MAX_NESTED_SITEMAPS = 5;

export class RobotsDisallowedError extends Error {
  public constructor(url: string) {
    super(`Fetching '${url}' is disallowed by the site's robots.txt.`);
    this.name = "RobotsDisallowedError";
  }
}

/**
 * Core content service. Ties together the rate-limited fetcher, the disk cache,
 * robots enforcement, sitemap discovery and HTML→markdown extraction.
 */
export class ContentService {
  private robotsRules?: RobotsRules;

  public constructor(
    private readonly config: AppConfig,
    private readonly cache: DiskCache,
    private readonly fetcher: Fetcher,
  ) {}

  /** Fetch a URL, preferring a fresh cache entry, then network, then a stale entry. */
  private async fetchWithCache(url: string): Promise<{ body: string; status: number; fetchedAt: string; fromCache: boolean }> {
    const cached = await this.cache.get(url);
    if (cached) return { body: cached.body, status: cached.status, fetchedAt: cached.fetchedAt, fromCache: true };
    try {
      const record = await this.fetcher.fetch(url);
      await this.cache.set(record);
      return { body: record.body, status: record.status, fetchedAt: record.fetchedAt, fromCache: false };
    } catch (error) {
      const stale = await this.cache.read(url);
      if (stale) return { body: stale.body, status: stale.status, fetchedAt: stale.fetchedAt, fromCache: true };
      throw error;
    }
  }

  private async getRobots(): Promise<RobotsRules> {
    if (this.robotsRules) return this.robotsRules;
    const robotsUrl = new URL("/robots.txt", this.config.baseUrl).toString();
    try {
      const { body, status } = await this.fetchWithCache(robotsUrl);
      this.robotsRules = status >= 200 && status < 300 ? parseRobots(body) : { disallow: [], allow: [], sitemaps: [] };
    } catch {
      this.robotsRules = { disallow: [], allow: [], sitemaps: [] };
    }
    return this.robotsRules;
  }

  private async assertAllowed(url: string): Promise<void> {
    const rules = await this.getRobots();
    const { pathname, search } = new URL(url);
    if (!isPathAllowed(rules, pathname + search)) throw new RobotsDisallowedError(url);
  }

  public async getPage(rawUrl: string): Promise<PageContent> {
    const url = new URL(rawUrl, this.config.baseUrl).toString();
    await this.assertAllowed(url);
    const { body, status, fetchedAt, fromCache } = await this.fetchWithCache(url);
    if (status >= 400) throw new Error(`Fetch failed for '${url}' with HTTP ${status}.`);

    const extracted = htmlToMarkdown(body, url);
    const content: PageContent = {
      url,
      markdown: extracted.markdown,
      contentLength: extracted.markdown.length,
      fetchedAt,
      fromCache,
    };
    if (extracted.title) content.title = extracted.title;
    if (extracted.canonicalUrl) content.canonicalUrl = extracted.canonicalUrl;
    return content;
  }

  /** Fetch and parse a sitemap, following one level of sitemap-index nesting. */
  private async loadSitemapEntries(sitemapUrl: string): Promise<SitemapEntry[]> {
    const { body, status } = await this.fetchWithCache(sitemapUrl);
    if (status >= 400 || !body.trim()) return [];
    const parsed = parseSitemap(body);
    if (parsed.entries.length > 0) return parsed.entries;

    const entries: SitemapEntry[] = [];
    for (const nested of parsed.sitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
      const { body: nestedBody, status: nestedStatus } = await this.fetchWithCache(nested);
      if (nestedStatus < 400 && nestedBody.trim()) entries.push(...parseSitemap(nestedBody).entries);
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
    const robots = await this.getRobots();
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

  public async search(query: string, limit: number): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const records = await this.cache.all();
    const hits: SearchHit[] = [];

    for (const record of records) {
      if (record.status >= 400) continue;
      const isHtml = (record.contentType?.includes("html") ?? false) || record.body.trimStart().startsWith("<");
      if (!isHtml) continue;

      const extracted = htmlToMarkdown(record.body, record.url);
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
      sitemapUrl: this.config.sitemapUrl,
      configuredPages: this.config.configuredPages.length,
      cacheDir: this.config.cacheDir,
      cacheTtlSeconds: this.config.cacheTtlSeconds,
      cacheEntries: stats.entries,
      cacheBytes: stats.bytes,
    };
    if (stats.lastFetchAt) status.lastFetchAt = stats.lastFetchAt;
    return status;
  }
}

function toListing(entry: SitemapEntry, source: PageListing["source"]): PageListing {
  const listing: PageListing = { url: entry.url, source };
  if (entry.lastModified) listing.lastModified = entry.lastModified;
  if (entry.priority !== undefined) listing.priority = entry.priority;
  return listing;
}
