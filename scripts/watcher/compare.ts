import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describePrice } from "../../src/pricing.js";
import { SnapshotStore } from "../../src/snapshots.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import { inline } from "./report.js";
import { watchKey } from "./run.js";
import { WATCHER_OUTPUT_DIR } from "./vault.js";

import type { PageFacts } from "../../src/facts.js";
import type { PlanPrice } from "../../src/pricing.js";
import type { WatchEntry, Watchlist } from "./watchlist.js";

export const COMPARISON_FILE = "Competitor Comparison.md";

export interface ComparisonRow {
  entry: WatchEntry;
  checkedAt?: string;
  lastChange?: string;
  facts?: PageFacts;
}

export interface ComparisonOptions {
  /** Include the owner's own pages as reference rows. */
  includeOwn?: boolean;
  /** Date shown as the update date. */
  now?: Date;
}

function headline(plans: PlanPrice[]): string {
  const priced = plans.filter((plan) => plan.amount !== undefined && plan.amount > 0 && plan.currency);
  if (priced.length === 0) return "none stated";
  // The lowest paid price is only comparable within one currency and period, so pick it from the most common pair.
  const groups = new Map<string, PlanPrice[]>();
  for (const plan of priced) groups.set(`${plan.currency}|${plan.period ?? ""}`, [...(groups.get(`${plan.currency}|${plan.period ?? ""}`) ?? []), plan]);
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? priced;
  const cheapest = [...best].sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0))[0];
  return cheapest ? `${describePrice(cheapest)} (${cheapest.name})` : "none stated";
}

function planList(plans: PlanPrice[]): string {
  return plans.slice(0, 8).map((plan) => `${plan.name}: ${describePrice(plan)}`).join("; ") + (plans.length > 8 ? `; and ${plans.length - 8} more` : "");
}

function freeTier(plans: PlanPrice[]): string {
  if (plans.length === 0) return "unknown";
  const free = plans.find((plan) => plan.free);
  if (free) return free.trial ? `yes, ${free.name} (trial)` : `yes, ${free.name}`;
  return plans.some((plan) => plan.trial) ? "trial only" : "none listed";
}

/** One Markdown note comparing the watched competitors. Deterministic; unknown values say so. */
export function renderComparison(rows: ComparisonRow[], options: ComparisonOptions = {}): string {
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const lines: string[] = [
    "---",
    "type: watcher-comparison",
    "mutability: living",
    `updated: ${day}`,
    `generator: website-content-watcher ${PACKAGE_VERSION}`,
    "---",
    "",
    "# Competitor comparison",
    "",
    `Updated ${day} from the watcher's stored snapshots. This note is overwritten on every run of the comparison command; the dated watcher reports are never touched. Values come from page text, which is untrusted web content, and a value the page does not state is shown as none stated or unknown.`,
    "",
  ];
  if (rows.length === 0) {
    lines.push("No competitor pages are on the watchlist.", "");
    return `${lines.join("\n")}\n`;
  }
  lines.push("| Page | Plans and prices | Headline price | Free tier | Key calls to action | Last change |", "|---|---|---|---|---|---|");
  for (const row of rows) {
    const plans = row.facts?.pricingTable?.plans ?? [];
    const name = `${inline(row.entry.label)}${row.entry.kind === "own-site" ? " (ours)" : ""}`;
    if (!row.facts) {
      lines.push(`| ${name} | no data yet | | | | |`);
      continue;
    }
    const ctas = (row.facts.hero?.ctas ?? row.facts.callsToAction?.map((cta) => cta.text) ?? []).slice(0, 3).map((text) => inline(text)).join("; ") || "none found";
    const plansText = plans.length > 0 ? inline(planList(plans)) : "no plan cards found";
    lines.push(`| ${name} | ${plansText} | ${plans.length > 0 ? inline(headline(plans)) : "unknown"} | ${freeTier(plans)} | ${ctas} | ${row.lastChange ?? "none since first seen"} |`);
  }
  lines.push("", "## Positioning", "");
  for (const row of rows) {
    const hero = row.facts?.hero;
    if (!hero?.h1 && !hero?.description) continue;
    lines.push(`- **${inline(row.entry.label)}**: ${hero.h1 ? `headline "${inline(hero.h1)}"` : "no headline found"}${hero.description ? `; description "${inline(hero.description)}"` : ""}.`);
  }
  const promos = rows.flatMap((row) => (row.facts?.pricingTable?.promos ?? []).map((promo) => `- **${inline(row.entry.label)}**: ${inline(promo)}`));
  if (promos.length > 0) lines.push("", "## Promotions showing now", "", ...promos);
  lines.push("");
  return `${lines.join("\n")}\n`.replace(/\n{3,}/gu, "\n\n");
}

/** Read the latest stored facts for each competitor page. */
export async function collectComparison(watchlist: Watchlist, outputDir: string, options: ComparisonOptions = {}): Promise<ComparisonRow[]> {
  const store = new SnapshotStore(path.join(path.resolve(outputDir), "snapshots"), { retentionDays: 3_650, maxEntries: 10_000, maxMarkdownChars: 200_000 });
  const rows: ComparisonRow[] = [];
  for (const entry of watchlist.items) {
    if (entry.kind !== "competitor" && !options.includeOwn) continue;
    const record = await store.read(watchKey(entry));
    const row: ComparisonRow = { entry };
    if (record) {
      row.checkedAt = record.current.fetchedAt;
      row.lastChange = (record.changedAt ?? record.firstSeenAt).slice(0, 10);
      if (record.current.facts) row.facts = record.current.facts as PageFacts;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Write the living comparison note. Only this one file is ever replaced, and
 * only if it is absent or is itself a watcher comparison note.
 */
export async function writeComparison(markdown: string, directory: string): Promise<string> {
  const file = path.join(directory, COMPARISON_FILE);
  if (existsSync(file)) {
    const existing = await readFile(file, "utf8");
    if (!/^---\r?\ntype: watcher-comparison\r?\n/u.test(existing)) {
      throw new Error(`'${file}' exists but is not a watcher comparison note, so it was not overwritten.`);
    }
  }
  await mkdir(directory, { recursive: true });
  await writeFile(file, markdown, "utf8");
  return file;
}

export function vaultComparisonDirectory(vaultDir: string): string {
  return path.join(path.resolve(vaultDir), ...WATCHER_OUTPUT_DIR);
}
