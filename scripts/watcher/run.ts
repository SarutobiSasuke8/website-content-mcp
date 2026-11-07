import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DiskCache } from "../../src/cache.js";
import { loadConfig } from "../../src/config.js";
import { diffLines, findAmounts, normalizeForWatch, summarizeDiff } from "../../src/diff.js";
import { PriceHistoryStore } from "../../src/price-history.js";
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
  /** Pages whose change has been seen fewer times than their `confirm-runs` setting needs. */
  pending: number;
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
  const isGone = page.availability === "missing";
  if (isGone && !wasGone) {
    result.status = "removed";
    result.summary = `The page now returns HTTP ${page.status} and has been removed or moved.`;
    result.factChanges.push({ kind: "page", severity: "high", material: true, type: "page_removed", description: `Page removed: it now returns HTTP ${page.status}.` });
    return result;
  }
  if (!isGone && wasGone) {
    result.status = "restored";
    result.summary = "The page is available again.";
    result.factChanges.push({ kind: "page", severity: "medium", material: true, type: "page_restored", description: "Page restored: it is available again." });
    return result;
  }

  result.status = "changed";
  const diff = diffLines(baseline.markdown, page.markdown);
  result.diff = diff;
  result.summary = summarizeDiff(diff, baseline.title, page.title);
  if (diff.addedCount === 0 && diff.removedCount === 0) {
    result.summary = "The visible text is the same; the page structure or its facts changed.";
  }
  const changes: FactChange[] = diffFacts(baseline.facts as PageFacts | undefined, page.facts, { priceThresholdPct: entry.priceThresholdPct });
  // Prices written in plain text also count when the page offers no structured price.
  if (!changes.some((change) => change.kind === "price" || change.kind === "plan")) {
    const gone = [...new Set(diff.removed.flatMap((line) => findAmounts(line)))].filter((amount) => !diff.added.some((line) => findAmounts(line).includes(amount)));
    const appeared = [...new Set(diff.added.flatMap((line) => findAmounts(line)))].filter((amount) => !diff.removed.some((line) => findAmounts(line).includes(amount)));
    if (gone.length > 0 || appeared.length > 0) {
      changes.push({
        kind: "price",
        severity: "high",
        material: true,
        type: "amounts_changed",
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

// Pending confirmation state: a change must be seen on consecutive runs before it counts.

interface Pending {
  compareKey: string;
  count: number;
  since: string;
}

const pendingFile = (outputDir: string, key: string): string => path.join(outputDir, "pending", `${sha256(key)}.json`);

async function readPending(outputDir: string, key: string): Promise<Pending | undefined> {
  try {
    return JSON.parse(await readFile(pendingFile(outputDir, key), "utf8")) as Pending;
  } catch {
    return undefined;
  }
}

async function writePending(outputDir: string, key: string, pending: Pending): Promise<void> {
  await mkdir(path.join(outputDir, "pending"), { recursive: true });
  await writeFile(pendingFile(outputDir, key), JSON.stringify(pending), "utf8");
}

// Append-only logs the weekly digest reads. Both are bounded.

export interface EventLogEntry {
  date: string;
  url: string;
  label: string;
  entryKind: string;
  watch: string;
  project?: string;
  kind: string;
  severity: string;
  type?: string;
  description: string;
  plan?: string;
  old?: string;
  new?: string;
  absoluteChange?: number;
  percentChange?: number;
}

export interface RunLogEntry {
  at: string;
  date: string;
  checked: number;
  changed: number;
  baselined: number;
  unchanged: number;
  errors: number;
  unavailable: number;
  pending: number;
  problems: { url: string; label: string; status: "error" | "unavailable"; reason: string }[];
}

const MAX_EVENT_LINES = 20_000;
const MAX_RUN_LINES = 2_000;

async function appendBounded(file: string, lines: string[], max: number): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${lines.join("\n")}\n`, "utf8");
  const text = await readFile(file, "utf8");
  const all = text.split("\n").filter(Boolean);
  if (all.length > max) await writeFile(file, `${all.slice(all.length - max).join("\n")}\n`, "utf8");
}

export async function readJsonLines<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const entries: T[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      // A damaged line is skipped, not fatal.
    }
  }
  return entries;
}

export const EVENTS_FILE = "events.jsonl";
export const RUNS_FILE = "runs.jsonl";
export const HISTORY_DIR = ["snapshots", "price-history"] as const;

export async function runWatcher(options: WatcherOptions): Promise<RunResult> {
  const dryRun = options.dryRun ?? false;
  const runDate = options.now ?? new Date();
  const runDay = runDate.toISOString().slice(0, 10);
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
    const history = new PriceHistoryStore(path.join(outputDir, ...HISTORY_DIR));

    const results: EntryResult[] = [];
    const written: string[] = [];
    for (const entry of items) {
      try {
        const page = await service.watchPage(entry.url, {
          site: entry.site,
          watch: entry.watch,
          ...(options.missingRetryDelayMs !== undefined ? { missingRetryDelayMs: options.missingRetryDelayMs } : {}),
          ...(entry.selector ? { selector: entry.selector } : {}),
          ...(entry.section ? { section: entry.section } : {}),
          ...(entry.ignore ? { ignore: entry.ignore } : {}),
        });
        if (page.availability === "unavailable") {
          // Not an observation: no baseline is touched and nothing material is raised.
          results.push({ entry, status: "unavailable", warnings: [...page.warnings], factChanges: [], ...(page.unavailableReason ? { error: page.unavailableReason } : {}) });
          continue;
        }
        const compareKey = watchKeyHash(page);
        const observation = {
          markdown: page.markdown,
          contentHash: page.contentHash,
          compareKey,
          fetchedAt: page.fetchedAt,
          status: page.status,
          ...(page.etag ? { etag: page.etag } : {}),
          ...(page.lastModified ? { lastModified: page.lastModified } : {}),
          ...(page.title ? { title: page.title } : {}),
          ...(page.facts ? { facts: page.facts } : {}),
        };
        const key = watchKey(entry);
        const persist = !dryRun;
        const comparison = await store.compare(key, observation);
        const pending = await readPending(outputDir, key);

        // A change must be seen on enough consecutive runs before it counts.
        if (comparison.status === "changed" && entry.confirmRuns > 1) {
          const count = pending && pending.compareKey === compareKey ? pending.count + 1 : 1;
          if (count < entry.confirmRuns) {
            if (persist) {
              await writePending(outputDir, key, { compareKey, count, since: pending?.compareKey === compareKey ? pending.since : page.fetchedAt });
              written.push(path.join(outputDir, "pending"));
            }
            results.push({
              entry,
              status: "pending",
              warnings: [...page.warnings],
              factChanges: [],
              summary: `A change was seen ${count} of ${entry.confirmRuns} times needed, so it is not reported yet.`,
              after: { fetchedAt: page.fetchedAt, contentHash: page.contentHash, httpStatus: page.status },
            });
            continue;
          }
        }
        if (persist) {
          await store.record(key, observation);
          if (comparison.status !== "unchanged") written.push(path.join(outputDir, "snapshots"));
          // A change that reverted, or one that is now confirmed, no longer needs its counter.
          if (pending) await rm(pendingFile(outputDir, key), { force: true });
        }
        const classified = classify(entry, page, comparison);
        results.push(classified);
        if (persist && comparison.status !== "unchanged" && page.availability === "ok" && page.facts?.pricingTable) {
          const renames = classified.factChanges
            .filter((change) => change.type === "plan_renamed" && change.old && change.new)
            .map((change) => ({ from: change.old ?? "", to: change.new ?? "" }));
          await history.record(entry.url, page.facts.pricingTable, { date: runDay, source: page.contentHash, renames });
        }
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
      pending: results.filter((result) => result.status === "pending").length,
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

    if (!dryRun) {
      const events: EventLogEntry[] = changedResults.flatMap((result) => result.factChanges.map((change) => {
        const line: EventLogEntry = {
          date: runDay,
          url: result.entry.url,
          label: result.entry.label,
          entryKind: result.entry.kind,
          watch: result.entry.watch,
          kind: change.kind,
          severity: change.severity,
          description: change.description,
        };
        if (result.entry.project) line.project = result.entry.project;
        if (change.type) line.type = change.type;
        if (change.plan) line.plan = change.plan;
        if (change.old !== undefined) line.old = change.old;
        if (change.new !== undefined) line.new = change.new;
        if (change.absoluteChange !== undefined) line.absoluteChange = change.absoluteChange;
        if (change.percentChange !== undefined) line.percentChange = change.percentChange;
        return line;
      }));
      await appendBounded(path.join(outputDir, EVENTS_FILE), events.map((event) => JSON.stringify(event)), MAX_EVENT_LINES);
      const run: RunLogEntry = {
        at: runDate.toISOString(),
        date: runDay,
        checked: results.length,
        changed: summary.changed,
        baselined: summary.baselined,
        unchanged: summary.unchanged,
        errors: summary.errors,
        unavailable: summary.unavailable,
        pending: summary.pending,
        problems: results
          .filter((result) => result.status === "error" || result.status === "unavailable")
          .slice(0, 50)
          .map((result) => ({ url: result.entry.url, label: result.entry.label, status: result.status as "error" | "unavailable", reason: result.error ?? "unknown" })),
      };
      await appendBounded(path.join(outputDir, RUNS_FILE), [JSON.stringify(run)], MAX_RUN_LINES);
    }
    return summary;
  } finally {
    if (dryRun) await rm(cacheDir, { recursive: true, force: true });
  }
}
