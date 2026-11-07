import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type WatchKind = "own-site" | "competitor";

/** What the page is, which decides the typed events it can produce. */
export type PageType = "general" | "pricing" | "changelog" | "blog" | "careers" | "integrations" | "security";

const PAGE_TYPES = ["general", "pricing", "changelog", "blog", "careers", "integrations", "security"] as const;

export interface WatchEntry {
  url: string;
  /** Host of the site; defaults to the URL's host and must match it. */
  site: string;
  label: string;
  whyItMatters: string;
  kind: WatchKind;
  /** CSS selector narrowing the compared content (the focus). */
  selector?: string;
  /** Heading text narrowing the compared content to that section (the focus). */
  section?: string;
  /** Vault project name for task lines, for example `Astraeus Business Solutions`. */
  project?: string;
  /** What the page is; defaults to `general`. Plans are read from every page that has plan cards. */
  watch: PageType;
  /** Noise to remove before comparing: CSS selectors and text patterns. */
  ignore?: { selectors?: string[] | undefined; text?: string[] | undefined };
  /** A change must appear in this many consecutive runs before it counts. Defaults to 1. */
  confirmRuns: number;
  /** Price changes smaller than this many per cent are shown but never material. Defaults to 0. */
  priceThresholdPct: number;
}

export interface Watchlist {
  items: WatchEntry[];
}

const rawEntry = z.object({
  url: z.string().url(),
  site: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).max(120),
  "why-it-matters": z.string().trim().min(1).max(500).optional(),
  whyItMatters: z.string().trim().min(1).max(500).optional(),
  kind: z.enum(["own-site", "competitor"]),
  selector: z.string().trim().min(1).max(300).optional(),
  section: z.string().trim().min(1).max(200).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  watch: z.enum(PAGE_TYPES).optional(),
  ignore: z.object({
    selectors: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    text: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  }).strict().optional(),
  focus: z.object({
    selector: z.string().trim().min(1).max(300).optional(),
    heading: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
  "confirm-runs": z.number().int().min(1).max(3).optional(),
  confirmRuns: z.number().int().min(1).max(3).optional(),
  "price-threshold-pct": z.number().min(0).max(100).optional(),
  priceThresholdPct: z.number().min(0).max(100).optional(),
}).strict();

const rawWatchlist = z.union([
  z.array(rawEntry),
  z.object({ version: z.number().optional(), items: z.array(rawEntry) }).strict(),
]);

const MAX_ENTRIES = 200;

function hostOf(url: string): string {
  return new URL(url).host.toLowerCase().replace(/^www\./u, "");
}

/** Validate a parsed watchlist document. Throws a readable error naming the problem. */
export function parseWatchlist(document: unknown): Watchlist {
  const result = rawWatchlist.safeParse(document);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid watchlist: ${problems.join("; ")}`);
  }
  const raw = Array.isArray(result.data) ? result.data : result.data.items;
  if (raw.length === 0) throw new Error("Invalid watchlist: it lists no pages.");
  if (raw.length > MAX_ENTRIES) throw new Error(`Invalid watchlist: ${raw.length} pages exceeds the limit of ${MAX_ENTRIES}.`);

  const seen = new Set<string>();
  const items: WatchEntry[] = raw.map((entry, index) => {
    const url = new URL(entry.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Invalid watchlist: item ${index + 1} must be an http or https URL.`);
    const site = entry.site ? hostOf(`https://${entry.site.replace(/^https?:\/\//iu, "")}`) : hostOf(entry.url);
    if (site !== hostOf(entry.url)) {
      throw new Error(`Invalid watchlist: item ${index + 1} ('${entry.label}') has site '${entry.site ?? ""}' but its URL is on '${hostOf(entry.url)}'.`);
    }
    const selector = entry.selector ?? entry.focus?.selector;
    const section = entry.section ?? entry.focus?.heading;
    const key = [entry.url, selector ?? "", section ?? ""].join("|");
    if (seen.has(key)) throw new Error(`Invalid watchlist: item ${index + 1} ('${entry.label}') repeats an earlier URL and hint.`);
    seen.add(key);
    const whyItMatters = entry["why-it-matters"] ?? entry.whyItMatters;
    if (!whyItMatters) throw new Error(`Invalid watchlist: item ${index + 1} ('${entry.label}') needs why-it-matters.`);
    return {
      url: url.toString(),
      site,
      label: entry.label,
      whyItMatters,
      kind: entry.kind,
      ...(selector ? { selector } : {}),
      ...(section ? { section } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      watch: entry.watch ?? "general",
      ...(entry.ignore ? { ignore: entry.ignore } : {}),
      confirmRuns: entry["confirm-runs"] ?? entry.confirmRuns ?? 1,
      priceThresholdPct: entry["price-threshold-pct"] ?? entry.priceThresholdPct ?? 0,
    };
  });
  return { items };
}

/** Read a YAML or JSON watchlist file. */
export async function loadWatchlist(file: string): Promise<Watchlist> {
  const text = await readFile(file, "utf8");
  const extension = path.extname(file).toLowerCase();
  let document: unknown;
  try {
    document = extension === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return parseWatchlist(document);
}
