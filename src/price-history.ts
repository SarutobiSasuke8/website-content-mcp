import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { perMonth } from "./pricing.js";

import type { BillingPeriod, PlanPrice, PricingTable } from "./pricing.js";

/** One observed price for one plan on one date. Compact on purpose. */
export interface PricePoint {
  date: string;
  plan: string;
  /** Null when the plan was no longer listed on this date. */
  amount: number | null;
  maxAmount?: number;
  currency?: string;
  period?: BillingPeriod;
  unit?: string;
  /** Content hash of the page version the point was read from. */
  source: string;
  /** The plan's earlier name, when this point starts a renamed plan. */
  renamedFrom?: string;
}

export interface PriceHistory {
  url: string;
  points: PricePoint[];
}

export interface PriceHistoryOptions {
  /** Points older than this many days are dropped, except the latest per plan. */
  retentionDays: number;
  /** Maximum points kept per page; the oldest go first. */
  maxPointsPerPage: number;
}

export const DEFAULT_PRICE_HISTORY_OPTIONS: PriceHistoryOptions = { retentionDays: 730, maxPointsPerPage: 2000 };

const DAY_MS = 86_400_000;
const planKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tuple = (point: Pick<PricePoint, "amount" | "maxAmount" | "currency" | "period" | "unit">): string =>
  JSON.stringify([point.amount, point.maxAmount ?? null, point.currency ?? null, point.period ?? null, point.unit ?? null]);

function pointOf(plan: PlanPrice, date: string, source: string): PricePoint {
  const point: PricePoint = { date, plan: plan.name, amount: plan.amount ?? null, source };
  if (plan.maxAmount !== undefined) point.maxAmount = plan.maxAmount;
  if (plan.currency) point.currency = plan.currency;
  if (plan.period) point.period = plan.period;
  if (plan.unit) point.unit = plan.unit;
  return point;
}

/**
 * Bounded time series of plan prices per page. A point is written only when a
 * plan appears, changes or disappears, so a stable page adds nothing.
 */
export class PriceHistoryStore {
  public constructor(
    private readonly dir: string,
    private readonly options: PriceHistoryOptions = DEFAULT_PRICE_HISTORY_OPTIONS,
  ) {}

  private filePath(url: string): string {
    return path.join(this.dir, `${createHash("sha256").update(url).digest("hex")}.json`);
  }

  public async read(url: string): Promise<PriceHistory> {
    const file = this.filePath(url);
    if (!existsSync(file)) return { url, points: [] };
    try {
      return JSON.parse(await readFile(file, "utf8")) as PriceHistory;
    } catch {
      return { url, points: [] };
    }
  }

  /** The most recent point of each plan that is still listed. */
  public static latest(points: PricePoint[]): PricePoint[] {
    const last = new Map<string, PricePoint>();
    for (const point of points) last.set(planKey(point.plan), point);
    return [...last.values()].filter((point) => point.amount !== null);
  }

  /**
   * Record the table seen on `date`. `renames` links a new plan name to its old
   * one so the series continues. Returns the number of points written.
   */
  public async record(
    url: string,
    table: PricingTable | undefined,
    meta: { date: string; source: string; renames?: { from: string; to: string }[] },
  ): Promise<number> {
    // A page without a plan table is not evidence that the plans are gone.
    if (!table || table.plans.length === 0) return 0;
    const history = await this.read(url);
    const lastByPlan = new Map<string, PricePoint>();
    for (const point of history.points) lastByPlan.set(planKey(point.plan), point);
    const renamedTo = new Map((meta.renames ?? []).map((rename) => [planKey(rename.to), rename.from]));
    // A plan that was renamed, now or earlier, is not a plan that disappeared.
    const renamedFrom = new Set([
      ...(meta.renames ?? []).map((rename) => planKey(rename.from)),
      ...history.points.flatMap((point) => (point.renamedFrom ? [planKey(point.renamedFrom)] : [])),
    ]);
    const added: PricePoint[] = [];

    const present = new Set<string>();
    for (const plan of table.plans) {
      const key = planKey(plan.name);
      present.add(key);
      // A plan with no stated price has nothing to chart.
      if (plan.amount === undefined) continue;
      const point = pointOf(plan, meta.date, meta.source);
      const previousName = renamedTo.get(key);
      const previous = lastByPlan.get(key) ?? (previousName ? lastByPlan.get(planKey(previousName)) : undefined);
      if (previous && previous.amount !== null && tuple(previous) === tuple(point) && !previousName) continue;
      if (previousName) point.renamedFrom = previousName;
      added.push(point);
    }
    for (const [key, previous] of lastByPlan) {
      if (present.has(key) || previous.amount === null || renamedFrom.has(key)) continue;
      added.push({ date: meta.date, plan: previous.plan, amount: null, source: meta.source });
    }
    if (added.length === 0) return 0;

    const points = [...history.points, ...added];
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(url), JSON.stringify({ url, points: this.bound(points) } satisfies PriceHistory), "utf8");
    return added.length;
  }

  private bound(points: PricePoint[]): PricePoint[] {
    const cutoff = new Date(Date.now() - this.options.retentionDays * DAY_MS).toISOString().slice(0, 10);
    const latest = new Set<PricePoint>();
    const lastByPlan = new Map<string, PricePoint>();
    for (const point of points) lastByPlan.set(planKey(point.plan), point);
    for (const point of lastByPlan.values()) latest.add(point);
    let kept = points.filter((point) => point.date >= cutoff || latest.has(point));
    if (kept.length > this.options.maxPointsPerPage) kept = kept.slice(kept.length - this.options.maxPointsPerPage);
    return kept;
  }

  /** Remove history files that have not been written for the retention period. */
  public async prune(now: number = Date.now()): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of (await readdir(this.dir)).filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(this.dir, name);
      if ((await stat(file)).mtimeMs < now - this.options.retentionDays * DAY_MS) {
        await rm(file, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** Every stored series, for the CSV export. */
  public async readAll(): Promise<PriceHistory[]> {
    if (!existsSync(this.dir)) return [];
    const result: PriceHistory[] = [];
    for (const name of (await readdir(this.dir)).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        result.push(JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as PriceHistory);
      } catch {
        // A damaged file is skipped, not fatal.
      }
    }
    return result.sort((a, b) => a.url.localeCompare(b.url));
  }
}

const csvCell = (value: string | number | null | undefined): string => {
  const text = value === null || value === undefined ? "" : String(value);
  // A leading formula character would be executed by a spreadsheet, so it is neutralised.
  const safe = /^[=+@-]/u.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
};

/** CSV with one row per point: date, url, plan, amount, upper amount, currency, period, unit, per-month equivalent, source hash, note. */
export function priceHistoryCsv(histories: PriceHistory[], filter: { plan?: string; since?: string } = {}): string {
  const header = "date,url,plan,amount,max_amount,currency,period,unit,per_month,source_hash,note";
  const rows: string[] = [];
  for (const history of histories) {
    for (const point of history.points) {
      if (filter.plan && planKey(point.plan) !== planKey(filter.plan)) continue;
      if (filter.since && point.date < filter.since) continue;
      const monthly = point.amount === null ? undefined : perMonth(point.amount, point.period);
      const note = point.amount === null ? "plan no longer listed" : point.renamedFrom ? `renamed from ${point.renamedFrom}` : "";
      rows.push([point.date, history.url, point.plan, point.amount, point.maxAmount, point.currency, point.period, point.unit, monthly, point.source.slice(0, 12), note].map(csvCell).join(","));
    }
  }
  return `${[header, ...rows].join("\n")}\n`;
}
