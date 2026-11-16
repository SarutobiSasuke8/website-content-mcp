import { createHash } from "node:crypto";

import { normalizeHost, parseSiteHost } from "./config.js";
import { htmlToMarkdown } from "./content.js";
import { extractFacts } from "./facts.js";
import { applyIgnore, restrictHtml } from "./section.js";
import { isPathAllowed, parseRobots } from "./robots.js";
import { diffLines, summarizeDiff } from "./diff.js";
import { auditHtml, comparableUrl, duplicateTitleFindings, looksLikeAsset, pageFindings, SEVERITIES } from "./site-health.js";
import { PriceHistoryStore } from "./price-history.js";
import { parseSitemap } from "./sitemap.js";

import type { DiskCache } from "./cache.js";
import type { LineDiff } from "./diff.js";
import type { PageFacts } from "./facts.js";
import type { IgnoreRules, SectionHint } from "./section.js";
import type { WatchKind } from "./signals.js";
import type { PricePoint } from "./price-history.js";
import type { PageRenderer } from "./render.js";
import type { SnapshotStore } from "./snapshots.js";
import type { HealthFinding, Severity } from "./site-health.js";
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
/** Overall time limit for one site-health pass. */
const HEALTH_DEADLINE_MS = 120_000;
/** Largest body read per fetch during a health pass; bigger pages are cut and flagged. */
const HEALTH_PAGE_BYTES = 1_000_000;
/** Hard limit for rendering one page in a browser. */
const RENDER_TIMEOUT_MS = 30_000;
/** Pause before the second look at a page that answered 404 or 410. */
const MISSING_RETRY_DELAY_MS = 3_000;
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

/** Result of comparing a page with its stored baseline. */
export interface PageDiff {
  url: string;
  finalUrl?: string;
  status: "first-seen" | "unchanged" | "changed";
  changed: boolean;
  /** How the current copy was obtained. */
  freshness: LoadOutcome;
  /** Whether this call stored the observed version as the new baseline. */
  baselineStored: boolean;
  old?: { contentHash: string; fetchedAt: string; title?: string };
  new: { contentHash: string; fetchedAt: string; title?: string };
  diff?: LineDiff;
  summary: string;
  warnings?: string[];
  sourceTrust: "untrusted-web-content";
}

/** Result of a bounded health check over one site. */
export interface SiteHealthReport {
  site: string;
  checkedAt: string;
  sitemapUrl: string;
  sitemapPages: number;
  pagesChecked: number;
  linksChecked: number;
  /** Pages and links not fetched because robots.txt disallows them. */
  skippedByRobots: number;
  summary: Record<Severity, number> & { total: number };
  /** Findings grouped by severity, most severe first. Each group is capped; `summary` holds true counts. */
  findings: Record<Severity, HealthFinding[]>;
  pages: { url: string; status: number | "error" | "robots-disallowed"; issues: string[] }[];
  truncated: boolean;
  warnings: string[];
  sourceTrust: "untrusted-web-content";
}

/** One observation of a page for the watcher: content, facts and how it was obtained. */
export interface WatchedPage {
  url: string;
  /**
   * `ok` when the page was read. `missing` only when HTTP 404 or 410 was seen on
   * two requests in one run. `unavailable` for 5xx, 429, timeouts, network
   * errors, other 4xx (blocking) and stale fallbacks: not an observation of the
   * page, so a caller must never replace a baseline or report a change from it.
   */
  availability: "ok" | "missing" | "unavailable";
  /** True when the content was read after running the script of the page. */
  rendered?: boolean;
  /** Why the page was unavailable. */
  unavailableReason?: string;
  status: number;
  fetchedAt: string;
  outcome: LoadOutcome;
  markdown: string;
  contentHash: string;
  title?: string;
  facts?: PageFacts;
  etag?: string;
  lastModified?: string;
  warnings: string[];
}

export class SectionNotFoundError extends Error {
  public constructor(url: string, hint: SectionHint) {
    super(`The ${hint.selector ? `selector '${hint.selector}'` : `section '${hint.section ?? ""}'`} matched nothing on '${url}'.`);
    this.name = "SectionNotFoundError";
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
  private readonly robotsByOrigin = new Map<string, RobotsResult>();
  private readonly completedRefreshByHost = new Map<string, string>();
  private readonly baseSite: SiteContext;

  public constructor(
    private readonly config: AppConfig,
    private readonly cache: DiskCache,
    private readonly fetcher: Fetcher,
    private readonly snapshots?: SnapshotStore,
    private readonly priceHistory?: PriceHistoryStore,
    private readonly renderer?: PageRenderer,
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
      // Any site other than the base site is fetched over https only, whatever scheme was typed.
      origin = new URL(`https://${site.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "")}`).origin;
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
    if (url.protocol === "http:" && normalizeHost(url.host) !== this.baseSite.host) {
      throw new Error(`Refusing '${url.toString()}': only the base site may be fetched over plain http.`);
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
  public async load(url: string, force = false, maxBytes?: number): Promise<LoadResult> {
    const stale = await this.cache.read(url);
    if (!force && stale && this.cache.isFresh(stale)) return { record: stale, fromCache: true, outcome: "fresh-cache" };

    const conditional: ConditionalHeaders = {};
    if (stale?.etag) conditional.etag = stale.etag;
    if (stale?.lastModified) conditional.lastModified = stale.lastModified;

    try {
      const fetched = await this.fetcher.fetch(url, conditional, maxBytes !== undefined ? { maxBytes } : undefined);
      if (isTransientStatus(fetched.status)) {
        // A 5xx or 429 says nothing about the page itself, so it never replaces a good cache entry.
        if (stale && stale.status < 400) {
          return { record: stale, fromCache: true, outcome: "stale-on-error", staleReason: `HTTP ${fetched.status}` };
        }
        return { record: fetched, fromCache: false, outcome: "fetched" };
      }
      if (fetched.status === 304 && stale) {
        // Unchanged upstream: keep the body (and its extraction), reset the clock.
        const revalidated: FetchRecord = { ...stale, fetchedAt: fetched.fetchedAt };
        await this.cache.set(revalidated);
        return { record: revalidated, fromCache: true, outcome: "not-modified" };
      }
      // A body cut short by a per-call cap must not be served later as the full page.
      if (!(maxBytes !== undefined && fetched.truncated)) await this.cache.set(fetched);
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

  /**
   * Compare the page with the baseline stored by the previous comparison, then
   * store the new version as the baseline. First sight stores a baseline and
   * reports no change; a 304 or a stale-on-error fallback is stated explicitly.
   */
  public async diffPage(
    rawUrl: string,
    options: { refresh?: boolean; site?: string; maxLines?: number; update?: boolean } = {},
  ): Promise<PageDiff> {
    if (!this.snapshots) throw new Error("Change snapshots are disabled (SNAPSHOT_MAX_ENTRIES=0).");
    const url = this.resolveAllowed(rawUrl, options.site);
    await this.assertAllowed(url);
    const loaded = await this.load(url, options.refresh ?? false);
    const { record } = loaded;
    if (record.status >= 400) throw new Error(`Fetch failed for '${url}' with HTTP ${record.status}.`);

    const extracted = await this.extractionOf(record);
    const markdown = extracted.markdown;
    const contentHash = createHash("sha256").update(markdown).digest("hex");
    const warnings: string[] = [];
    if (extracted.extractionQuality !== "full") {
      warnings.push(`Extraction quality is '${extracted.extractionQuality}', so a comparison covers only what the server could read.`);
    }
    if (loaded.outcome === "stale-on-error") {
      warnings.push(`The origin could not be reached (${loaded.staleReason ?? "unknown error"}); this comparison uses the cached copy fetched at ${record.fetchedAt}.`);
    }

    const observation = {
      markdown,
      contentHash,
      fetchedAt: record.fetchedAt,
      ...(record.etag ? { etag: record.etag } : {}),
      ...(record.lastModified ? { lastModified: record.lastModified } : {}),
      ...(extracted.title ? { title: extracted.title } : {}),
      status: record.status,
    };
    // Never promote a copy served because the origin failed to a new baseline.
    const store = options.update !== false && loaded.outcome !== "stale-on-error";
    const comparison = store
      ? await this.snapshots.record(url, observation)
      : await this.snapshots.compare(url, observation);

    // Keep a compact series of plan prices whenever the stored version changes.
    if (store && comparison.status !== "unchanged" && this.priceHistory && isHtml(record)) {
      const table = extractFacts(record.body, record.finalUrl ?? url).pricingTable;
      await this.priceHistory.record(url, table, { date: record.fetchedAt.slice(0, 10), source: contentHash });
    }

    const result: PageDiff = {
      url,
      status: comparison.status,
      changed: comparison.status === "changed",
      freshness: loaded.outcome,
      baselineStored: store && comparison.status !== "unchanged",
      new: { contentHash, fetchedAt: record.fetchedAt, ...(extracted.title ? { title: extracted.title } : {}) },
      summary: "",
      sourceTrust: "untrusted-web-content",
    };
    if (record.finalUrl) result.finalUrl = record.finalUrl;
    const baseline = comparison.baseline;
    if (baseline) {
      result.old = {
        contentHash: baseline.contentHash,
        fetchedAt: baseline.fetchedAt,
        ...(baseline.title ? { title: baseline.title } : {}),
      };
    }

    const validation = loaded.outcome === "not-modified" ? " The origin answered 304 Not Modified." : "";
    if (comparison.status === "first-seen") {
      result.summary = store
        ? `First time this page has been seen; its content was stored as the baseline for later comparisons.${validation}`
        : "First time this page has been seen, and no baseline was stored.";
    } else if (comparison.status === "unchanged") {
      result.summary = `The page content is unchanged since ${baseline?.fetchedAt ?? "the baseline"}.${validation}`;
    } else if (baseline) {
      const diff = diffLines(baseline.markdown, markdown, options.maxLines !== undefined ? { maxLines: options.maxLines } : {});
      result.diff = diff;
      result.summary = `The page changed since ${baseline.fetchedAt}. ${summarizeDiff(diff, baseline.title, extracted.title)}${validation}`;
      if (baseline.storedTruncated || comparison.observed.storedTruncated) {
        warnings.push("The stored text was clipped to the snapshot size bound, so the line diff covers only the beginning of the page.");
      }
    }
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /** Stored price history for a page: every point, or one plan's, plus the latest price of each listed plan. */
  public async getPriceHistory(
    rawUrl: string,
    options: { site?: string; plan?: string; limit?: number } = {},
  ): Promise<{ url: string; available: boolean; points: PricePoint[]; latest: PricePoint[]; truncated: boolean; note?: string }> {
    if (!this.priceHistory) throw new Error("Price history is disabled (SNAPSHOT_MAX_ENTRIES=0).");
    const url = this.resolveAllowed(rawUrl, options.site);
    const history = await this.priceHistory.read(url);
    const wanted = options.plan?.toLowerCase().trim();
    const points = history.points.filter((point) => !wanted || point.plan.toLowerCase() === wanted);
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const shown = points.slice(Math.max(0, points.length - limit));
    const result = {
      url,
      available: history.points.length > 0,
      points: shown,
      latest: PriceHistoryStore.latest(history.points).filter((point) => !wanted || point.plan.toLowerCase() === wanted),
      truncated: points.length > shown.length,
    };
    return history.points.length === 0
      ? { ...result, note: "No price history is stored for this URL. It is recorded when content_diff or the watcher sees a page with plan cards whose prices changed or appeared." }
      : result;
  }

  /** Structured, bounded facts read from a page's HTML. Unknown values are omitted. */
  public async getFacts(
    rawUrl: string,
    options: { refresh?: boolean; site?: string } = {},
  ): Promise<{ url: string; finalUrl?: string; fetchedAt: string; fromCache: boolean; facts: PageFacts; sourceTrust: "untrusted-web-content" }> {
    const url = this.resolveAllowed(rawUrl, options.site);
    await this.assertAllowed(url);
    const { record, fromCache } = await this.load(url, options.refresh ?? false);
    if (record.status >= 400) throw new Error(`Fetch failed for '${url}' with HTTP ${record.status}.`);
    const facts: PageFacts = isHtml(record)
      ? extractFacts(record.body, record.finalUrl ?? url)
      : { warnings: ["The response is not an HTML page, so no page facts were extracted."] };
    if (record.truncated) facts.warnings = [...(facts.warnings ?? []), "The response was cut at the size cap, so the facts may be incomplete."];
    return {
      url,
      ...(record.finalUrl ? { finalUrl: record.finalUrl } : {}),
      fetchedAt: record.fetchedAt,
      fromCache,
      facts,
      sourceTrust: "untrusted-web-content",
    };
  }

  /**
   * Check a site's pages for common search and structure problems. Bounded in
   * pages and links, and every fetch goes through the same robots check, cache
   * and rate-limited fetcher as the other tools.
   */
  public async siteHealth(options: { site?: string; maxPages?: number; maxLinks?: number; deadlineMs?: number } = {}): Promise<SiteHealthReport> {
    const deadline = Date.now() + Math.max(1_000, Math.min(options.deadlineMs ?? HEALTH_DEADLINE_MS, 600_000));
    let deadlineHit = false;
    const context = this.siteFor(options.site);
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 25, 200));
    const maxLinks = Math.max(0, Math.min(options.maxLinks ?? 25, 200));
    const warnings: string[] = [];
    const all: HealthFinding[] = [];
    const pages: SiteHealthReport["pages"] = [];

    const sitemap = await this.loadSitemapEntries(context.sitemapUrl, context.host);
    warnings.push(...sitemap.warnings);
    const sitemapUrls = sitemap.entries
      .map((entry) => entry.url)
      .filter((url) => {
        const same = isSameSite(url, context.host);
        if (!same) warnings.push(`Ignored off-site sitemap entry '${url}'.`);
        return same;
      });
    const listed = sitemapUrls.length > 0 ? sitemapUrls : (context.configuredPages.length > 0 ? context.configuredPages : [context.baseUrl]);
    if (sitemapUrls.length === 0) warnings.push("No sitemap pages were found, so only the configured pages were checked and the not-in-sitemap check is not meaningful.");
    const sitemapSet = new Set(sitemapUrls.map(comparableUrl));
    const window = listed.slice(0, maxPages);
    const checked = new Set<string>();

    let skippedByRobots = 0;
    const titles = new Map<string, string>();
    const linkSources = new Map<string, string>();

    for (const raw of window) {
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
      let url: string;
      try {
        url = this.resolveAllowed(raw, options.site);
      } catch {
        continue;
      }
      checked.add(comparableUrl(url));
      if (!(await this.isRobotsAllowed(url))) {
        skippedByRobots += 1;
        pages.push({ url, status: "robots-disallowed", issues: [] });
        continue;
      }
      let loaded: LoadResult;
      try {
        loaded = await this.load(url, false, HEALTH_PAGE_BYTES);
      } catch (error) {
        all.push({ severity: "critical", check: "sitemap-page-unreachable", url, detail: `The page could not be fetched: ${error instanceof Error ? error.message : "unknown error"}` });
        pages.push({ url, status: "error", issues: ["sitemap-page-unreachable"] });
        continue;
      }
      const { record } = loaded;
      if (record.status !== 200) {
        all.push({ severity: "critical", check: "sitemap-non-200", url, detail: `The sitemap lists this page but it returned HTTP ${record.status}.` });
        pages.push({ url, status: record.status, issues: ["sitemap-non-200"] });
        continue;
      }
      const issues: HealthFinding[] = [];
      if (record.finalUrl && comparableUrl(record.finalUrl) !== comparableUrl(url)) {
        issues.push({ severity: "medium", check: "sitemap-redirect", url, detail: `The sitemap lists this URL but it redirects to ${record.finalUrl}.` });
      }
      if (isHtml(record)) {
        const audit = auditHtml(record.body, record.finalUrl ?? url, context.host);
        issues.push(...pageFindings(url, audit));
        if (audit.title) titles.set(url, audit.title);
        for (const link of audit.internalLinks) {
          if (!linkSources.has(link)) linkSources.set(link, url);
        }
      }
      all.push(...issues);
      pages.push({ url, status: 200, issues: issues.map((issue) => issue.check) });
    }
    all.push(...duplicateTitleFindings(titles));
    for (const page of pages) {
      const dupe = all.some((finding) => finding.check === "duplicate-title" && finding.url === page.url);
      if (dupe) page.issues.push("duplicate-title");
    }

    // Links: check targets not already examined, within the budget.
    let linksChecked = 0;
    let linksTruncated = false;
    for (const [target, source] of linkSources) {
      if (checked.has(comparableUrl(target)) || looksLikeAsset(target)) continue;
      if (linksChecked >= maxLinks) {
        linksTruncated = true;
        break;
      }
      if (Date.now() > deadline) {
        deadlineHit = true;
        break;
      }
      let url: string;
      try {
        url = this.resolveAllowed(target, options.site);
      } catch {
        continue;
      }
      checked.add(comparableUrl(url));
      if (!(await this.isRobotsAllowed(url))) {
        skippedByRobots += 1;
        continue;
      }
      linksChecked += 1;
      try {
        const { record } = await this.load(url, false, HEALTH_PAGE_BYTES);
        if (record.status >= 400) {
          all.push({ severity: "critical", check: "broken-internal-link", url, detail: `Linked from ${source} but returned HTTP ${record.status}.`, related: [source] });
        } else if (record.status === 200 && sitemapUrls.length > 0) {
          const inSitemap = sitemapSet.has(comparableUrl(url)) || (record.finalUrl !== undefined && sitemapSet.has(comparableUrl(record.finalUrl)));
          if (!inSitemap) {
            all.push({ severity: "medium", check: "linked-not-in-sitemap", url, detail: `Linked from ${source} and reachable, but missing from the sitemap.`, related: [source] });
          }
        }
      } catch (error) {
        all.push({ severity: "critical", check: "broken-internal-link", url, detail: `Linked from ${source} but could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`, related: [source] });
      }
    }
    if (deadlineHit) warnings.push("The check stopped at its time limit, so later pages and links were not examined.");
    if (linksTruncated) warnings.push(`The link check stopped at ${maxLinks} links; raise max_links to check more.`);
    if (listed.length > maxPages) warnings.push(`Only the first ${maxPages} of ${listed.length} sitemap pages were checked; raise max_pages to check more.`);

    const PER_GROUP_CAP = 100;
    const findings: Record<Severity, HealthFinding[]> = { critical: [], high: [], medium: [], low: [] };
    const summary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    for (const finding of all) {
      summary[finding.severity] += 1;
      summary.total += 1;
    }
    let truncated = linksTruncated || deadlineHit || listed.length > maxPages;
    for (const severity of SEVERITIES) {
      const group = all
        .filter((finding) => finding.severity === severity)
        .sort((a, b) => a.check.localeCompare(b.check) || a.url.localeCompare(b.url));
      if (group.length > PER_GROUP_CAP) truncated = true;
      findings[severity] = group.slice(0, PER_GROUP_CAP);
    }

    return {
      site: context.host,
      checkedAt: new Date().toISOString(),
      sitemapUrl: context.sitemapUrl,
      sitemapPages: sitemapUrls.length,
      pagesChecked: pages.length,
      linksChecked,
      skippedByRobots,
      summary,
      findings,
      pages: pages.slice(0, 200),
      truncated,
      warnings,
      sourceTrust: "untrusted-web-content",
    };
  }

  /**
   * Observe a page for a watcher. A page that has gone (HTTP 4xx or 5xx) is
   * returned with its status rather than thrown, so the caller can report the
   * removal. Robots refusals, off-site URLs and unmatched section hints throw.
   */
  public async watchPage(
    rawUrl: string,
    options: SectionHint & { site?: string; missingRetryDelayMs?: number; ignore?: IgnoreRules; watch?: WatchKind; render?: boolean } = {},
  ): Promise<WatchedPage> {
    const url = this.resolveAllowed(rawUrl, options.site);
    await this.assertAllowed(url);
    const emptyHash = createHash("sha256").update("").digest("hex");
    const unavailable = (status: number, reason: string, outcome: LoadOutcome, fetchedAt = new Date().toISOString()): WatchedPage => ({
      url, availability: "unavailable", unavailableReason: reason, status, fetchedAt, outcome,
      markdown: "", contentHash: emptyHash, warnings: [`The page could not be observed this time (${reason}); nothing was compared or stored.`],
    });

    let loaded: LoadResult;
    try {
      loaded = await this.load(url);
    } catch (error) {
      return unavailable(0, error instanceof Error ? error.message : "unknown error", "stale-on-error");
    }
    // A fallback copy, a 5xx, a 429 or a blocked request is not an observation of the page.
    if (loaded.outcome === "stale-on-error") {
      return unavailable(loaded.record.status, loaded.staleReason ?? "the origin could not be reached", loaded.outcome, loaded.record.fetchedAt);
    }
    if (isTransientStatus(loaded.record.status)) {
      return unavailable(loaded.record.status, `HTTP ${loaded.record.status}`, loaded.outcome, loaded.record.fetchedAt);
    }
    // Removal needs a second look: only 404 or 410 seen twice in one run counts.
    if (loaded.record.status === 404 || loaded.record.status === 410) {
      const delay = options.missingRetryDelayMs ?? MISSING_RETRY_DELAY_MS;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        loaded = await this.load(url, true);
      } catch (error) {
        return unavailable(0, error instanceof Error ? error.message : "unknown error", "stale-on-error");
      }
      if (loaded.outcome === "stale-on-error" || isTransientStatus(loaded.record.status)) {
        return unavailable(loaded.record.status, loaded.staleReason ?? `HTTP ${loaded.record.status}`, loaded.outcome, loaded.record.fetchedAt);
      }
    }
    const { record } = loaded;
    const warnings: string[] = [];
    const base = {
      url,
      status: record.status,
      fetchedAt: record.fetchedAt,
      outcome: loaded.outcome,
      ...(record.etag ? { etag: record.etag } : {}),
      ...(record.lastModified ? { lastModified: record.lastModified } : {}),
    };
    if (record.status === 404 || record.status === 410) {
      return { ...base, availability: "missing", markdown: "", contentHash: emptyHash, warnings };
    }
    if (record.status >= 400) {
      // 401, 403 and other refusals describe access, not removal.
      return unavailable(record.status, `HTTP ${record.status} (access refused, not treated as removal)`, loaded.outcome, record.fetchedAt);
    }

    let extracted: ExtractedContent;
    let facts: PageFacts | undefined;
    let body = record.body;
    let rendered = false;
    if (options.render && isHtml(record)) {
      const reason = "rendered content unavailable";
      if (!this.renderer) {
        return unavailable(record.status, `${reason}: rendering was requested for this page but no renderer is set up (install playwright-core and use Chrome or Edge).`, loaded.outcome, record.fetchedAt);
      }
      try {
        // The page load counts against the host rate limit like any other request.
        await this.fetcher.waitTurn?.(url);
        const host = normalizeHost(new URL(url).host);
        const page = await withTimeout(
          this.renderer.render({
            url: record.finalUrl ?? url,
            timeoutMs: RENDER_TIMEOUT_MS,
            userAgent: this.config.userAgent,
            allowRequest: (target) => isSameSite(target, host) && (target.startsWith("https:") || host === this.baseSite.host),
          }),
          RENDER_TIMEOUT_MS + 5_000,
          "Rendering timed out.",
        );
        if (!isSameSite(page.finalUrl, host)) throw new Error(`The page redirected to ${page.finalUrl}, which is a different site.`);
        body = page.html;
        rendered = true;
      } catch (error) {
        return unavailable(record.status, `${reason}: ${error instanceof Error ? error.message : "unknown error"}`, loaded.outcome, record.fetchedAt);
      }
    }
    if (isHtml(record)) {
      const hint: SectionHint = {
        ...(options.selector ? { selector: options.selector } : {}),
        ...(options.section ? { section: options.section } : {}),
      };
      const restricted = restrictHtml(body, record.finalUrl ?? url, hint);
      if (restricted === undefined) throw new SectionNotFoundError(url, hint);
      const hinted = Boolean(hint.selector ?? hint.section);
      const ignoring = (options.ignore?.selectors?.length ?? 0) > 0 || (options.ignore?.text?.length ?? 0) > 0;
      const source = ignoring ? applyIgnore(restricted, record.finalUrl ?? url, options.ignore ?? {}) : restricted;
      extracted = hinted || ignoring || rendered ? htmlToMarkdown(source, record.finalUrl ?? url) : await this.extractionOf(record);
      facts = extractFacts(source, record.finalUrl ?? url, options.watch ? { watch: options.watch } : {});
    } else {
      extracted = await this.extractionOf(record);
    }
    if (record.truncated) warnings.push("The response was cut at the size cap, so the content may be incomplete.");
    if (extracted.extractionQuality !== "full") {
      if (rendered) {
        return unavailable(record.status, "rendered content unavailable: the page still had no readable content after rendering", loaded.outcome, record.fetchedAt);
      }
      warnings.push(`Extraction quality is '${extracted.extractionQuality}', so only what the server could read is compared.${options.render ? "" : " If the page builds its content with script, set render: true for it in the watchlist."}`);
    }
    return {
      ...base,
      availability: "ok",
      markdown: extracted.markdown,
      contentHash: createHash("sha256").update(extracted.markdown).digest("hex"),
      ...(extracted.title ? { title: extracted.title } : {}),
      ...(facts ? { facts } : {}),
      ...(rendered ? { rendered: true } : {}),
      warnings,
    };
  }

  /** Fetch and parse a sitemap, following one level of sitemap-index nesting. */
  private async loadSitemapEntries(sitemapUrl: string, host: string): Promise<SitemapLoadResult> {
    if (!this.isAllowedHost(sitemapUrl) || !isSameSite(sitemapUrl, host)) {
      return { entries: [], warnings: [`Refused off-host sitemap '${sitemapUrl}'.`] };
    }
    // A sitemap may only list pages of the site it was requested for.
    const onSite = (entries: SitemapEntry[], warnings: string[]): SitemapEntry[] => {
      const kept = entries.filter((entry) => isSameSite(entry.url, host));
      if (kept.length < entries.length) warnings.push(`Ignored ${entries.length - kept.length} sitemap entries that are not on ${host}.`);
      return kept;
    };
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
    if (parsed.entries.length > 0) {
      const topWarnings: string[] = [];
      return { entries: onSite(parsed.entries, topWarnings), warnings: topWarnings };
    }

    const entries: SitemapEntry[] = [];
    const warnings: string[] = [];
    for (const nested of parsed.sitemaps.slice(0, MAX_NESTED_SITEMAPS)) {
      if (!this.isAllowedHost(nested) || !isSameSite(nested, host)) {
        warnings.push(`Ignored nested sitemap '${nested}' because it is not on ${host}.`);
        continue;
      }
      const { record: nestedRecord } = await this.load(nested);
      if (nestedRecord.status < 400 && nestedRecord.body.trim() && looksLikeSitemap(nestedRecord)) {
        entries.push(...onSite(parseSitemap(nestedRecord.body).entries, warnings));
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
    const result = await this.loadSitemapEntries(context.sitemapUrl, context.host);
    return { site: context.host, sitemapUrl: context.sitemapUrl, available: result.entries.length > 0, ...result };
  }

  public async listPages(limit: number, offset = 0, site?: string): Promise<{ site: string; source: PageListing["source"]; pages: PageListing[]; warnings: string[] }> {
    const context = this.siteFor(site);
    const start = Math.max(0, Math.floor(offset));
    const warnings: string[] = [];
    // 1. Configured sitemap.
    const sitemap = await this.loadSitemapEntries(context.sitemapUrl, context.host);
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
      const result = await this.loadSitemapEntries(sitemapUrl, context.host);
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A 5xx or 429 describes the server's state, not the page. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
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
