import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DiskCache } from "../../src/cache.js";
import { loadConfig } from "../../src/config.js";
import { diffLines, findAmounts, normalizeForWatch, summarizeDiff } from "../../src/diff.js";
import { createRuntime } from "../../src/runtime.js";
import { ContentService } from "../../src/service.js";
import { SnapshotStore } from "../../src/snapshots.js";
import { diffFacts, factsForComparison } from "./deltas.js";
import { isReportable, renderReport } from "./report.js";

import type { Fetcher } from "../../src/fetcher.js";
import type { PageFacts } from "../../src/facts.js";
import type { WatchedPage } from "../../src/service.js";
import type { SnapshotComparison } from "../../src/snapshots.js";
import type { FactChange } from "./deltas.js";
import type { EntryResult } from "./report.js";
import type { WatchEntry, Watchlist } from "./watchlist.js";

export interface WatcherOptions {
  watchlist: Watchlist;
  /** Holds snapshots, reports and the HTTP cache. */
  outputDir: string;
  /** Fetch and compare, but write nothing. */
  dryRun?: boolean;
  /** Clock for the run date and report name. */
  now?: Date;
  /** Replace the network fetcher, for tests. */
  fetcher?: Pick<Fetcher, "fetch">;
  /** Minimum milliseconds between requests to one host. Defaults to the server default of 1000. */
  minIntervalMs?: number;
  /** Permit fetching hosts that resolve to private addresses. For local test sites only. */
  allowPrivateNetwork?: boolean;
  userAgent?: string;
  /** Pause before re-checking a page that answered 404 or 410. Defaults to 3000. */
  missingRetryDelayMs?: number;
}

export interface RunResult {
  runDate: Date;
  results: EntryResult[];
  changed: number;
  baselined: number;
  unchanged: number;
  errors: number;
  /** Pages that could not be observed this time (5xx, 429, timeouts, blocked). Nothing was stored for them. */
  unavailable: number;
  /** Markdown for the run when at least one page changed. */
  reportMarkdown?: string;
  /** Path of the report written, when not a dry run. */
  reportPath?: string;
  dryRun: boolean;
  /** Files created or changed by this run, excluding the internal HTTP cache. */
  written: string[];
}

export function watchKey(entry: WatchEntry): string {
  const hint = entry.selector ? `#css=${entry.selector}` : entry.section ? `#section=${entry.section}` : "";
  return `${entry.url}${hint}`;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function watchKeyHash(page: WatchedPage): string {
  if (page.availability === "missing") return "gone";
  return sha256(`${normalizeForWatch(page.markdown)}\n#facts\n${JSON.stringify(factsForComparison(page.facts))}`);
}

function classify(entry: WatchEntry, page: WatchedPage, comparison: SnapshotComparison): EntryResult {
  const result: EntryResult = {
    entry,
    status: "unchanged",
    warnings: [...page.warnings],
    factChanges: [],
    after: { fetchedAt: page.fetchedAt, contentHash: page.contentHash, httpStatus: page.status },
  };
  const baseline = comparison.baseline;
  if (baseline) result.before = { fetchedAt: baseline.fetchedAt, contentHash: baseline.contentHash };

  if (comparison.status === "first-seen") {
    result.status = "baselined";
    if (page.status >= 400) result.warnings.push(`The page returned HTTP ${page.status} on first sight, so the baseline records it as unavailable.`);
    return result;
  }
  if (comparison.status === "unchanged") {
    result.noiseOnly = baseline !== undefined && baseline.contentHash !== page.contentHash;
    return result;
  }
  if (!baseline) return result;

  const wasGone = (baseline.status ?? 200) >= 400;
  const isGone = page.status >= 400;
  if (isGone && !wasGone) {
    result.status = "removed";
    result.summary = `The page now returns HTTP ${page.status} and has been removed or moved.`;
    result.factChanges.push({ kind: "page", material: true, description: `Page removed: it now returns HTTP ${page.status}.` });
    return result;
  }
  if (!isGone && wasGone) {
    result.status = "restored";
    result.summary = "The page is available again.";
    result.factChanges.push({ kind: "page", material: true, description: "Page restored: it is available again." });
    return result;
  }

  result.status = "changed";
  const diff = diffLines(baseline.markdown, page.markdown);
  result.diff = diff;
  const oldTitle = baseline.title;
  result.summary = summarizeDiff(diff, oldTitle, page.title);
  if (diff.addedCount === 0 && diff.removedCount === 0) {
    result.summary = "The visible text is the same; the page structure or its facts changed.";
  }
  const changes: FactChange[] = diffFacts(baseline.facts as PageFacts | undefined, page.facts);
  // Prices written in plain text also count when the page offers no structured price.
  if (!changes.some((change) => change.kind === "price")) {
    const gone = [...new Set(diff.removed.flatMap((line) => findAmounts(line)))].filter((amount) => !diff.added.some((line) => findAmounts(line).includes(amount)));
    const appeared = [...new Set(diff.added.flatMap((line) => findAmounts(line)))].filter((amount) => !diff.removed.some((line) => findAmounts(line).includes(amount)));
    if (gone.length > 0 || appeared.length > 0) {
      changes.push({
        kind: "price",
        material: true,
        description: `Amounts in the text changed: ${gone.length > 0 ? `no longer shown ${gone.slice(0, 4).join(", ")}` : ""}${gone.length > 0 && appeared.length > 0 ? "; " : ""}${appeared.length > 0 ? `now shown ${appeared.slice(0, 4).join(", ")}` : ""}.`,
      });
    }
  }
  result.factChanges.push(...changes);
  return result;
}

async function nextReportPath(dir: string, runDate: Date, suffix = "Watcher Report"): Promise<string> {
  const day = runDate.toISOString().slice(0, 10);
  let candidate = path.join(dir, `${day} ${suffix}.md`);
  for (let n = 2; existsSync(candidate); n += 1) candidate = path.join(dir, `${day} ${suffix} ${n}.md`);
  return candidate;
}

export { nextReportPath };

export async function runWatcher(options: WatcherOptions): Promise<RunResult> {
  const dryRun = options.dryRun ?? false;
  const runDate = options.now ?? new Date();
  const outputDir = path.resolve(options.outputDir);
  const items = options.watchlist.items;
  const first = items[0];
  if (!first) throw new Error("The watchlist lists no pages.");

  // A dry run must leave no trace, so its HTTP cache lives in a throwaway directory.
  const cacheDir = dryRun ? await mkdtemp(path.join(os.tmpdir(), "wcm-watch-dry-")) : path.join(outputDir, "cache");
  try {
    const hosts = [...new Set(items.map((item) => item.site))];
    const config = loadConfig({
      SITE_BASE_URL: new URL(first.url).origin,
      SITE_ALLOWLIST: hosts.join(","),
      CACHE_DIR: cacheDir,
      CACHE_TTL_SECONDS: "0",
      SNAPSHOT_MAX_ENTRIES: "0",
      ...(options.minIntervalMs !== undefined ? { FETCH_MIN_INTERVAL_MS: String(options.minIntervalMs) } : {}),
      ...(options.allowPrivateNetwork ? { FETCH_ALLOW_PRIVATE_NETWORK: "true" } : {}),
      ...(options.userAgent ? { USER_AGENT: options.userAgent } : {}),
    } as NodeJS.ProcessEnv);
    const runtime = createRuntime(config);
    const service = options.fetcher
      ? new ContentService(config, new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries), options.fetcher as Fetcher)
      : runtime.service;
    const store = new SnapshotStore(path.join(outputDir, "snapshots"), {
      retentionDays: 3_650,
      maxEntries: 10_000,
      maxMarkdownChars: config.snapshotMaxMarkdownChars,
    });

    const results: EntryResult[] = [];
    const written: string[] = [];
    for (const entry of items) {
      try {
        const page = await service.watchPage(entry.url, {
          site: entry.site,
          ...(options.missingRetryDelayMs !== undefined ? { missingRetryDelayMs: options.missingRetryDelayMs } : {}),
          ...(entry.selector ? { selector: entry.selector } : {}),
          ...(entry.section ? { section: entry.section } : {}),
        });
        if (page.availability === "unavailable") {
          // Not an observation: no baseline is touched and nothing material is raised.
          results.push({ entry, status: "unavailable", warnings: [...page.warnings], factChanges: [], ...(page.unavailableReason ? { error: page.unavailableReason } : {}) });
          continue;
        }
        const observation = {
          markdown: page.markdown,
          contentHash: page.contentHash,
          compareKey: watchKeyHash(page),
          fetchedAt: page.fetchedAt,
          status: page.status,
          ...(page.etag ? { etag: page.etag } : {}),
          ...(page.lastModified ? { lastModified: page.lastModified } : {}),
          ...(page.title ? { title: page.title } : {}),
          ...(page.facts ? { facts: page.facts } : {}),
        };
        // A copy served only because the origin failed is never promoted to a baseline.
        const persist = !dryRun && page.outcome !== "stale-on-error";
        const key = watchKey(entry);
        const comparison = persist ? await store.record(key, observation) : await store.compare(key, observation);
        if (persist && comparison.status !== "unchanged") written.push(path.join(outputDir, "snapshots"));
        results.push(classify(entry, page, comparison));
      } catch (error) {
        results.push({
          entry,
          status: "error",
          error: error instanceof Error ? error.message : "unknown error",
          warnings: [],
          factChanges: [],
        });
      }
    }

    const changedResults = results.filter(isReportable);
    const summary: RunResult = {
      runDate,
      results,
      changed: changedResults.length,
      baselined: results.filter((result) => result.status === "baselined").length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      errors: results.filter((result) => result.status === "error").length,
      unavailable: results.filter((result) => result.status === "unavailable").length,
      dryRun,
      written: [...new Set(written)],
    };
    if (changedResults.length > 0) {
      summary.reportMarkdown = renderReport(results, { runDate, total: results.length });
      if (!dryRun) {
        const reportsDir = path.join(outputDir, "reports");
        await mkdir(reportsDir, { recursive: true });
        summary.reportPath = await nextReportPath(reportsDir, runDate);
        await writeFile(summary.reportPath, summary.reportMarkdown, "utf8");
        summary.written.push(summary.reportPath);
      }
    }
    return summary;
  } finally {
    if (dryRun) await rm(cacheDir, { recursive: true, force: true });
  }
}
