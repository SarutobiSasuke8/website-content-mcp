import { createHash } from "node:crypto";

import { normalizeHost, parseSiteHost } from "./config.js";
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

interface RobotsResult {
  rules: RobotsRules;
  warnings: string[];
}

interface SitemapLoadResult {
  entries: SitemapEntry[];
  warnings: string[];
}

export class RobotsDisallowedError extends Error {
  public constructor(url: string) {
    super(`Fetching '${url}' is disallowed by the site's robots.txt.`);
    this.name = "RobotsDisallowedError";
  }
}

export class SiteNotAllowedError extends Error {
  public constructor(site: string, allowed: string[]) {
    super(`Site '${site}' is not on the site allowlist (${allowed.join(", ")}).`);
    this.name = "SiteNotAllowedError";
  }
}

/** One allowlisted site: where its pages and sitemap live. */
export interface SiteContext {
  host: string;
  baseUrl: string;
  sitemapUrl: string;
  configuredPages: string[];
}

/** How a load was satisfied, so callers can report 304s and stale fallbacks explicitly. */
export type LoadOutcome = "fresh-cache" | "fetched" | "not-modified" | "stale-on-error";

export interface LoadResult {
  record: FetchRecord;
  fromCache: boolean;
  outcome: LoadOutcome;
  /** Why the origin could not be reached, when `outcome` is `stale-on-error`. */
  staleReason?: string;
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
  private readonly robotsByOrigin = new Map<string, RobotsResult>();
  private readonly completedRefreshByHost = new Map<string, string>();
  private readonly baseSite: SiteContext;

  public constructor(
    private readonly config: AppConfig,
    private readonly cache: DiskCache,
    private readonly fetcher: Fetcher,
  ) {
    this.baseSite = {
      host: normalizeHost(new URL(config.baseUrl).host),
      baseUrl: config.baseUrl,
      sitemapUrl: config.sitemapUrl,
      configuredPages: config.configuredPages,
    };
  }

  /**
   * Resolve the optional `site` argument. Anything not on the site allowlist is
   * refused before any network access. The base site is the default.
   */
  public siteFor(site?: string): SiteContext {
    if (site === undefined || site.trim() === "") return this.baseSite;
    let host: string;
    let origin: string;
    try {
      host = parseSiteHost(site);
      const raw = site.trim();
      origin = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`).origin;
    } catch {
      throw new SiteNotAllowedError(site, this.config.siteAllowlist);
    }
    if (!this.config.siteAllowlist.includes(host)) throw new SiteNotAllowedError(site, this.config.siteAllowlist);
    if (host === this.baseSite.host) return this.baseSite;
    return {
      host,
      baseUrl: `${origin}/`,
      sitemapUrl: new URL("/sitemap.xml", origin).toString(),
      configuredPages: [],
    };
  }

  /**
   * Resolve a reference against the base URL and confirm the result is a
   * fetchable http(s) URL on an allowed host.
   */
  public resolveAllowed(rawUrl: string, site?: string): string {
    const context = this.siteFor(site);
    let url: URL;
    try {
      url = new URL(rawUrl, context.baseUrl);
    } catch {
      throw new Error(`'${rawUrl}' is not a valid URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new HostNotAllowedError(url.toString(), this.config.allowedHosts);
    }
    if (!this.config.allowedHosts.includes(normalizeHost(url.host))) {
      throw new HostNotAllowedError(url.toString(), this.config.allowedHosts);
    }
    if (site !== undefined && site.trim() !== "" && normalizeHost(url.host) !== context.host) {
      throw new HostNotAllowedError(url.toString(), [context.host]);
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
  public async load(url: string, force = false): Promise<LoadResult> {
    const stale = await this.cache.read(url);
    if (!force && stale && this.cache.isFresh(stale)) return { record: stale, fromCache: true, outcome: "fresh-cache" };

    const conditional: ConditionalHeaders = {};
    if (stale?.etag) conditional.etag = stale.etag;
    if (stale?.lastModified) conditional.lastModified = stale.lastModified;

    try {
      const fetched = await this.fetcher.fetch(url, conditional);
      if (fetched.status === 304 && stale) {
        // Unchanged upstream: keep the body (and its extraction), reset the clock.
        const revalidated: FetchRecord = { ...stale, fetchedAt: fetched.fetchedAt };
        await this.cache.set(revalidated);
        return { record: revalidated, fromCache: true, outcome: "not-modified" };
      }
      await this.cache.set(fetched);
      return { record: fetched, fromCache: false, outcome: "fetched" };
    } catch (error) {
      if (stale) {
        return {
          record: stale,
          fromCache: true,
          outcome: "stale-on-error",
          staleReason: error instanceof Error ? error.message : "unknown error",
        };
      }
      throw error;
    }
  }

  /**
   * Markdown for a record, computed once and written back to the cache so
   * search never re-parses the same HTML.
   */
  public async extractionOf(record: FetchRecord): Promise<ExtractedContent> {
    if (record.extracted?.extractionMethod && record.extracted.extractionQuality) return record.extracted;
    const extracted = isPlainText(record)
      ? plainTextExtraction(record.body)
      : htmlToMarkdown(record.body, record.url);
    await this.cache.set({ ...record, extracted });
    return extracted;
  }

  private async getRobots(origin: string): Promise<RobotsResult> {
    const cached = this.robotsByOrigin.get(origin);
    if (cached) return cached;

    const robotsUrl = new URL("/robots.txt", origin).toString();
    let rules: RobotsRules = EMPTY_ROBOTS;
    const warnings: string[] = [];
    try {
      const { record } = await this.load(robotsUrl);
      if (record.status >= 200 && record.status < 300) {
        if (looksLikeHtml(record)) {
          warnings.push(`${robotsUrl} returned HTML instead of a robots.txt document.`);
        } else {
          rules = parseRobots(record.body);
        }
      } else {
        warnings.push(`${robotsUrl} returned HTTP ${record.status}.`);
      }
    } catch (error) {
      rules = EMPTY_ROBOTS;
      warnings.push(`${robotsUrl} could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const result = { rules, warnings };
    this.robotsByOrigin.set(origin, result);
    return result;
  }

  /** Whether robots.txt for the URL's own origin permits fetching it. */
  private async isRobotsAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const robots = await this.getRobots(parsed.origin);
    return isPathAllowed(robots.rules, parsed.pathname + parsed.search);
  }

  private async assertAllowed(url: string): Promise<void> {
    if (!(await this.isRobotsAllowed(url))) throw new RobotsDisallowedError(url);
  }

  public async getPage(
    rawUrl: string,
    options: { maxLength?: number; refresh?: boolean; site?: string } = {},
  ): Promise<PageContent> {
    const url = this.resolveAllowed(rawUrl, options.site);
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
      extractionMethod: extracted.extractionMethod,
      extractionQuality: extracted.extractionQuality,
      sourceTrust: "untrusted-web-content",
    };
    if (record.finalUrl) content.finalUrl = record.finalUrl;
    if (record.etag) content.etag = record.etag;
    if (record.lastModified) content.lastModified = record.lastModified;
    if (extracted.title) content.title = extracted.title;
    if (extracted.canonicalUrl) content.canonicalUrl = extracted.canonicalUrl;
    if (extracted.products) content.products = extracted.products;
    if (extracted.warnings) content.warnings = extracted.warnings;
    return content;
  }

  /** Fetch and parse a sitemap, following one level of sitemap-index nesting. */
  private async loadSitemapEntries(sitemapUrl: string): Promise<SitemapLoadResult> {
    if (!this.isAllowedHost(sitemapUrl)) {
      return { entries: [], warnings: [`Refused off-host sitemap '${sitemapUrl}'.`] };
    }
    const { record } = await this.load(sitemapUrl);
    if (record.status >= 400) {
      return { entries: [], warnings: [`${sitemapUrl} returned HTTP ${record.status}.`] };
    }
    if (!record.body.trim()) {
      return { entries: [], warnings: [`${sitemapUrl} was empty.`] };
    }
    if (!looksLikeSitemap(record)) {
      return { entries: [], warnings: [`${sitemapUrl} did not return a recognizable XML sitemap.`] };
    }
    const parsed = parseSitemap(record.body);
    if (parsed.entries.length > 0) return { entries: parsed.entries, warnings: [] };

    const entries: SitemapEntry[] = [];
    const warnings: string[] = [];
    for (const nested of parsed.sitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
      if (!this.isAllowedHost(nested)) continue;
      const { record: nestedRecord } = await this.load(nested);
      if (nestedRecord.status < 400 && nestedRecord.body.trim() && looksLikeSitemap(nestedRecord)) {
        entries.push(...parseSitemap(nestedRecord.body).entries);
      } else {
        warnings.push(`${nested} did not return a usable XML sitemap.`);
      }
    }
    if (entries.length === 0 && parsed.sitemaps.length === 0) {
      warnings.push(`${sitemapUrl} contained no page or nested-sitemap entries.`);
    }
    return { entries, warnings };
  }

  public async getSitemap(site?: string): Promise<{ site: string; sitemapUrl: string; available: boolean; entries: SitemapEntry[]; warnings: string[] }> {
    const context = this.siteFor(site);
    const result = await this.loadSitemapEntries(context.sitemapUrl);
    return { site: context.host, sitemapUrl: context.sitemapUrl, available: result.entries.length > 0, ...result };
  }

  public async listPages(limit: number, offset = 0, site?: string): Promise<{ site: string; source: PageListing["source"]; pages: PageListing[]; warnings: string[] }> {
    const context = this.siteFor(site);
    const start = Math.max(0, Math.floor(offset));
    const warnings: string[] = [];
    // 1. Configured sitemap.
    const sitemap = await this.loadSitemapEntries(context.sitemapUrl);
    warnings.push(...sitemap.warnings);
    if (sitemap.entries.length > 0) {
      return {
        site: context.host,
        source: "sitemap",
        pages: sitemap.entries.slice(start, start + limit).map((entry) => toListing(entry, "sitemap")),
        warnings,
      };
    }

    // 2. Sitemaps advertised in robots.txt.
    const robots = await this.getRobots(new URL(context.baseUrl).origin);
    warnings.push(...robots.warnings);
    for (const sitemapUrl of robots.rules.sitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
      const result = await this.loadSitemapEntries(sitemapUrl);
      warnings.push(...result.warnings);
      if (result.entries.length > 0) {
        return {
          site: context.host,
          source: "robots",
          pages: result.entries.slice(start, start + limit).map((entry) => toListing(entry, "robots")),
          warnings,
        };
      }
    }

    // 3. Configured page list (defaulting to the base URL).
    const configured = context.configuredPages.length > 0 ? context.configuredPages : [context.baseUrl];
    return {
      site: context.host,
      source: "configured",
      pages: configured.slice(start, start + limit).map((url) => ({ url, source: "configured" as const })),
      warnings,
    };
  }

  /**
   * Warm the cache by walking the site's discoverable pages, so `search` has
   * something to search. Robots-disallowed and off-host URLs are skipped.
   */
  public async refresh(limit: number, force = false, offset = 0, site?: string): Promise<RefreshResult> {
    const context = this.siteFor(site);
    const { source, pages, warnings } = await this.listPages(limit, offset, site);
    const result: RefreshResult = {
      site: context.host,
      source,
      requested: pages.length,
      fetched: 0,
      revalidated: 0,
      skipped: 0,
      failed: [],
    };
    if (warnings.length > 0) result.warnings = warnings;

    for (const page of pages) {
      try {
        const url = this.resolveAllowed(page.url, site);
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

    this.completedRefreshByHost.set(context.host, new Date().toISOString());
    return result;
  }

  /** Completion time of the latest cache refresh pass for a site (default: the base site), or null. */
  public lastRefreshAtFor(site?: string): string | null {
    return this.completedRefreshByHost.get(this.siteFor(site).host) ?? null;
  }

  /** Completion time of the latest cache refresh pass for the base site, or null before the first pass. */
  public get lastRefreshAt(): string | null {
    return this.completedRefreshByHost.get(this.baseSite.host) ?? null;
  }

  public async search(query: string, limit: number, site?: string): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const context = this.siteFor(site);
    const records = await this.cache.all();
    const hits: SearchHit[] = [];

    for (const record of records) {
      if (record.status >= 400) continue;
      // Results never cross sites: only cached pages of the selected site match.
      if (!isSameSite(record.url, context.host)) continue;
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
      siteAllowlist: this.config.siteAllowlist,
      sitemapUrl: this.config.sitemapUrl,
      configuredPages: this.config.configuredPages.length,
      cacheDir: this.config.cacheDir,
      cacheTtlSeconds: this.config.cacheTtlSeconds,
      cacheMaxEntries: this.config.cacheMaxEntries,
      cacheEntries: stats.entries,
      cacheBytes: stats.bytes,
      lastRefreshAt: this.lastRefreshAt,
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

function looksLikeHtml(record: FetchRecord): boolean {
  const type = record.contentType?.toLowerCase() ?? "";
  if (type.includes("html")) return true;
  const head = record.body.trimStart().slice(0, 300).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html");
}

function looksLikeSitemap(record: FetchRecord): boolean {
  const type = record.contentType?.toLowerCase() ?? "";
  const head = record.body.trimStart().slice(0, 500).toLowerCase();
  if (head.includes("<urlset") || head.includes("<sitemapindex")) return true;
  return (type.includes("xml") || type.includes("application/rss"))
    && (head.startsWith("<?xml") || head.startsWith("<urlset") || head.startsWith("<sitemapindex"));
}

function isPlainText(record: FetchRecord): boolean {
  return record.contentType?.toLowerCase().includes("text/plain") ?? false;
}

function plainTextExtraction(body: string): ExtractedContent {
  const markdown = body.replace(/\u00A0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    markdown,
    extractionMethod: markdown ? "plain-text" : "empty",
    extractionQuality: markdown ? "full" : "empty",
    ...(markdown ? {} : { warnings: ["The text response was empty."] }),
  };
}

function isSameSite(url: string, host: string): boolean {
  try {
    return normalizeHost(new URL(url).host) === host;
  } catch {
    return false;
  }
}

function toListing(entry: SitemapEntry, source: PageListing["source"]): PageListing {
  const listing: PageListing = { url: entry.url, source };
  if (entry.lastModified) listing.lastModified = entry.lastModified;
  if (entry.priority !== undefined) listing.priority = entry.priority;
  return listing;
}
