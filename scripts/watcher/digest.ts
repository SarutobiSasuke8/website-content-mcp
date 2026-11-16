import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_VERSION } from "../../src/version.js";
import { inline } from "./report.js";
import { EVENTS_FILE, nextReportPath, readJsonLines, RUNS_FILE } from "./run.js";
import { WATCHER_OUTPUT_DIR } from "./vault.js";

import type { EventLogEntry, RunLogEntry } from "./run.js";

export interface DigestOptions {
  /** End of the window; defaults to now. */
  now?: Date;
  /** Days covered, default 7. */
  days?: number;
  /** How many runs the schedule should have produced in the window, default 1. */
  expectedRuns?: number;
}

export interface Digest {
  markdown: string;
  from: string;
  to: string;
  events: number;
  runs: number;
  missedRuns: number;
}

const PRICE_TYPES = new Set(["price_up", "price_down", "price_changed", "plan_added", "plan_removed", "plan_renamed", "currency_changed", "period_changed", "unit_changed", "rate_changed", "free_tier_added", "free_tier_removed", "amounts_changed"]);
const ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const DAY_MS = 86_400_000;

function cell(value: string | number | undefined): string {
  return value === undefined ? "" : inline(String(value));
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

/** Deterministic summary of the window: no language model, only the logged events and runs. */
export function buildDigest(events: EventLogEntry[], runs: RunLogEntry[], options: DigestOptions = {}): Digest {
  const to = options.now ?? new Date();
  const days = options.days ?? 7;
  const fromDate = new Date(to.getTime() - days * DAY_MS);
  const from = fromDate.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  const inWindow = <T extends { date: string }>(item: T): boolean => item.date > from && item.date <= toDay;
  const windowEvents = events.filter(inWindow).sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3) || a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const windowRuns = runs.filter(inWindow);
  const expected = options.expectedRuns ?? 1;
  const missedRuns = Math.max(0, expected - windowRuns.length);
  const lastRun = [...runs].sort((a, b) => a.at.localeCompare(b.at)).at(-1);

  const important = windowEvents.filter((event) => event.severity === "high" || event.severity === "medium");
  const low = windowEvents.filter((event) => event.severity === "low");
  const changedUrls = new Set(windowEvents.map((event) => event.url));
  const checked = lastRun?.checked ?? 0;
  const unchangedCount = Math.max(0, checked - changedUrls.size);

  const lines: string[] = [
    "---",
    "type: watcher-digest",
    "mutability: append-only",
    `window-start: ${from}`,
    `window-end: ${toDay}`,
    `generator: website-content-watcher ${PACKAGE_VERSION}`,
    "---",
    "",
    `# Weekly watcher digest ${toDay}`,
    "",
    `Covers ${from} (exclusive) to ${toDay}. ${important.length} high or medium events, ${low.length} low events, ${windowRuns.length} runs. Page text quoted here is untrusted web content.`,
    "",
  ];

  lines.push("## High and medium events", "");
  if (important.length === 0) lines.push("None this week.", "");
  else {
    for (const event of important) lines.push(`- [${event.severity}] ${event.date} **${cell(event.label)}** (${event.entryKind}${event.watch !== "general" ? `, ${event.watch}` : ""}): ${cell(event.description)}`);
    lines.push("");
  }

  lines.push("## Price movement", "");
  const priceEvents = windowEvents.filter((event) => event.type !== undefined && PRICE_TYPES.has(event.type));
  if (priceEvents.length === 0) lines.push("No price or plan movement this week.", "");
  else {
    lines.push("| Date | Page | Plan | Event | Old | New | Change | Change % |", "|---|---|---|---|---|---|---|---|");
    for (const event of priceEvents) {
      lines.push(`| ${event.date} | ${cell(event.label)} | ${cell(event.plan)} | ${cell(event.type)} | ${cell(event.old)} | ${cell(event.new)} | ${event.absoluteChange === undefined ? "" : `${event.absoluteChange > 0 ? "+" : ""}${event.absoluteChange}`} | ${event.percentChange === undefined ? "" : `${event.percentChange > 0 ? "+" : ""}${event.percentChange}%`} |`);
    }
    lines.push("");
  }

  const kinds = group(important.filter((event) => event.type !== undefined && !PRICE_TYPES.has(event.type)), (event) => event.type ?? "other");
  if (kinds.size > 0) {
    lines.push("## Competitor signals", "");
    for (const [type, items] of [...kinds].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`- ${type}: ${items.length} (${[...new Set(items.map((item) => cell(item.label)))].join(", ")})`);
    lines.push("");
  }

  lines.push("## Unchanged", "", `${unchangedCount} of the ${checked} pages checked in the last run had no changes in this window.${low.length > 0 ? ` ${low.length} low-severity changes (copy, headings, titles, new posts and roles) are in the dated reports.` : ""}`, "");

  lines.push("## Pages that were unavailable", "");
  const problems = windowRuns.flatMap((run) => run.problems.map((problem) => ({ ...problem, date: run.date })));
  if (problems.length === 0) lines.push("None. Every page could be checked in every run.", "");
  else {
    lines.push("| Page | Problem | Runs affected | Last reason |", "|---|---|---|---|");
    for (const [url, items] of [...group(problems, (problem) => problem.url)].sort((a, b) => a[0].localeCompare(b[0]))) {
      const last = items.at(-1);
      lines.push(`| ${cell(last?.label ?? url)} | ${cell(last?.status)} | ${items.length} | ${cell(last?.reason)} |`);
    }
    lines.push("");
  }

  lines.push("## Run health", "");
  lines.push(`- Runs in the window: ${windowRuns.length} of ${expected} expected${missedRuns > 0 ? `, so ${missedRuns} missed` : ""}.`);
  lines.push(`- Pages checked in the last run: ${checked}.`);
  lines.push(`- Errors in the window: ${windowRuns.reduce((sum, run) => sum + run.errors, 0)}. Unavailable: ${windowRuns.reduce((sum, run) => sum + run.unavailable, 0)}.`);
  lines.push(`- Last run: ${lastRun ? lastRun.at : "none recorded"}${lastRun ? `, ${Math.floor((to.getTime() - new Date(lastRun.at).getTime()) / DAY_MS)} days ago` : ""}.`);
  if (missedRuns > 0) lines.push("- A missed run means the scheduled task did not run or the machine was off. Nothing was lost, but changes since the last run are not yet seen.");
  lines.push("");

  return { markdown: `${lines.join("\n")}\n`.replace(/\n{3,}/gu, "\n\n"), from, to: toDay, events: windowEvents.length, runs: windowRuns.length, missedRuns };
}

/** Read the logs in a watcher output directory and build the digest. */
export async function digestFromDirectory(outputDir: string, options: DigestOptions = {}): Promise<Digest> {
  const dir = path.resolve(outputDir);
  const [events, runs] = await Promise.all([
    readJsonLines<EventLogEntry>(path.join(dir, EVENTS_FILE)),
    readJsonLines<RunLogEntry>(path.join(dir, RUNS_FILE)),
  ]);
  return buildDigest(events, runs, options);
}

/** Write the digest as a new dated note. Never overwrites an earlier one. */
export async function writeDigest(digest: Digest, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = await nextReportPath(directory, new Date(`${digest.to}T00:00:00Z`), "Weekly Watcher Digest");
  await writeFile(file, digest.markdown, { encoding: "utf8", flag: "wx" });
  return file;
}

export function vaultDigestDirectory(vaultDir: string): string {
  return path.join(path.resolve(vaultDir), ...WATCHER_OUTPUT_DIR);
}
