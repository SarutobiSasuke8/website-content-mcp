#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/runtime.js";

interface DogfoodSiteConfig {
  name: string;
  baseUrl: string;
  pageLimit?: number;
  pages?: string[];
}

interface DogfoodConfig {
  sites: DogfoodSiteConfig[];
}

export interface PageObservation {
  url: string;
  finalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  contentHash: string;
  contentLength: number;
  extractionMethod: string;
  extractionQuality: string;
  fetchedAt: string;
  fromCache: boolean;
  etag?: string;
  lastModified?: string;
  warnings?: string[];
}

interface DogfoodState {
  schemaVersion: 1;
  updatedAt: string;
  sites: Record<string, { baseUrl: string; pages: Record<string, PageObservation> }>;
}

export type ObservationStatus = "baseline" | "unchanged" | "changed";

interface PageRunResult {
  url: string;
  status: ObservationStatus | "failed";
  observation?: PageObservation;
  previousHash?: string;
  error?: string;
}

interface SiteRunResult {
  name: string;
  baseUrl: string;
  discoverySource: string;
  discoveryWarnings: string[];
  pages: PageRunResult[];
}

interface DogfoodRun {
  schemaVersion: 1;
  runAt: string;
  sites: SiteRunResult[];
  totals: {
    sites: number;
    pages: number;
    baseline: number;
    unchanged: number;
    changed: number;
    failed: number;
    degraded: number;
    discoveryWarnings: number;
    revalidated: number;
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function comparableUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.search = "";
  const pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/u, "");
  return `${url.origin}${pathname}`;
}

export function compareObservation(
  previous: PageObservation | undefined,
  current: PageObservation,
): ObservationStatus {
  if (!previous) return "baseline";
  return previous.contentHash === current.contentHash ? "unchanged" : "changed";
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function observationOf(page: Awaited<ReturnType<ReturnType<typeof createRuntime>["service"]["getPage"]>>): PageObservation {
  const observation: PageObservation = {
    url: page.url,
    contentHash: page.contentHash,
    contentLength: page.contentLength,
    extractionMethod: page.extractionMethod,
    extractionQuality: page.extractionQuality,
    fetchedAt: page.fetchedAt,
    fromCache: page.fromCache,
  };
  if (page.finalUrl) observation.finalUrl = page.finalUrl;
  if (page.canonicalUrl) observation.canonicalUrl = page.canonicalUrl;
  if (page.title) observation.title = page.title;
  if (page.etag) observation.etag = page.etag;
  if (page.lastModified) observation.lastModified = page.lastModified;
  const warnings = [...(page.warnings ?? [])];
  const effectiveUrl = page.finalUrl ?? page.url;
  if (page.canonicalUrl && comparableUrl(page.canonicalUrl) !== comparableUrl(effectiveUrl)) {
    warnings.push(`Canonical URL '${page.canonicalUrl}' does not match the effective page URL '${effectiveUrl}'.`);
  }
  if (warnings.length > 0) observation.warnings = warnings;
  return observation;
}

async function runSite(
  site: DogfoodSiteConfig,
  dataDir: string,
  previous: DogfoodState,
): Promise<SiteRunResult> {
  const siteSlug = slug(site.name);
  const config = loadConfig({
    SITE_BASE_URL: site.baseUrl,
    CACHE_DIR: path.join(dataDir, "cache", siteSlug),
    CACHE_TTL_SECONDS: "0",
    CACHE_MAX_ENTRIES: "1000",
    FETCH_MIN_INTERVAL_MS: "1000",
  } as NodeJS.ProcessEnv);
  const { service } = createRuntime(config);
  const pageLimit = site.pageLimit ?? 5;
  const discovery = await service.listPages(Math.max(pageLimit, 1));
  const selectedUrls = site.pages?.length
    ? site.pages.slice(0, pageLimit).map((page) => new URL(page, config.baseUrl).toString())
    : discovery.pages.slice(0, pageLimit).map((page) => page.url);
  const previousPages = previous.sites[siteSlug]?.pages ?? {};
  const pages: PageRunResult[] = [];

  for (const url of selectedUrls) {
    try {
      const page = await service.getPage(url, { refresh: true, maxLength: 1_000 });
      const observation = observationOf(page);
      const prior = previousPages[url];
      const status = compareObservation(prior, observation);
      const result: PageRunResult = { url, status, observation };
      if (status === "changed" && prior) result.previousHash = prior.contentHash;
      pages.push(result);
    } catch (error) {
      pages.push({
        url,
        status: "failed",
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  const duplicateHashes = new Map<string, { requested: string; effective: string }[]>();
  for (const page of pages) {
    const observation = page.observation;
    if (!observation) continue;
    const hash = observation.contentHash;
    const urls = duplicateHashes.get(hash) ?? [];
    urls.push({ requested: page.url, effective: comparableUrl(observation.finalUrl ?? page.url) });
    duplicateHashes.set(hash, urls);
  }
  const duplicateWarnings = [...duplicateHashes.values()]
    .filter((urls) => urls.length > 1 && new Set(urls.map((url) => url.effective)).size > 1)
    .map((urls) => `Identical extracted content was observed across: ${urls.map((url) => url.requested).join(", ")}`);

  return {
    name: site.name,
    baseUrl: config.baseUrl,
    discoverySource: discovery.source,
    discoveryWarnings: [...discovery.warnings, ...duplicateWarnings],
    pages,
  };
}

function totalsOf(sites: SiteRunResult[]): DogfoodRun["totals"] {
  const pages = sites.flatMap((site) => site.pages);
  return {
    sites: sites.length,
    pages: pages.length,
    baseline: pages.filter((page) => page.status === "baseline").length,
    unchanged: pages.filter((page) => page.status === "unchanged").length,
    changed: pages.filter((page) => page.status === "changed").length,
    failed: pages.filter((page) => page.status === "failed").length,
    degraded: pages.filter((page) =>
      page.observation?.extractionQuality === "metadata-only" || page.observation?.extractionQuality === "empty"
    ).length,
    discoveryWarnings: sites.reduce((sum, site) => sum + site.discoveryWarnings.length, 0),
    revalidated: pages.filter((page) => page.observation?.fromCache === true).length,
  };
}

function markdownReport(run: DogfoodRun): string {
  const lines = [
    `# Website Content MCP dogfood run — ${run.runAt}`,
    "",
    `Sites: ${run.totals.sites} · Pages: ${run.totals.pages} · Baselines: ${run.totals.baseline} · Unchanged: ${run.totals.unchanged} · Changed: ${run.totals.changed} · Failed: ${run.totals.failed} · Degraded: ${run.totals.degraded} · Revalidated: ${run.totals.revalidated}`,
    "",
  ];
  for (const site of run.sites) {
    lines.push(`## ${site.name}`, "", `Discovery: ${site.discoverySource}`);
    for (const warning of site.discoveryWarnings) lines.push(`- Discovery warning: ${warning}`);
    lines.push("", "| Status | Quality | Length | URL |", "|---|---:|---:|---|");
    for (const page of site.pages) {
      lines.push(
        `| ${page.status} | ${page.observation?.extractionQuality ?? "—"} | ${page.observation?.contentLength ?? "—"} | ${page.url} |`,
      );
      for (const warning of page.observation?.warnings ?? []) lines.push(``, `> ${page.url}: ${warning}`);
      if (page.error) lines.push(``, `> ${page.url}: ${page.error}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function parseArgs(argv: string[]): { configFile: string; dataDir: string } {
  let configFile = "dogfood/owned-sites.json";
  let dataDir = ".dogfood-data";
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config" && argv[index + 1]) configFile = argv[++index] ?? configFile;
    else if (value === "--data-dir" && argv[index + 1]) dataDir = argv[++index] ?? dataDir;
  }
  return { configFile: path.resolve(configFile), dataDir: path.resolve(dataDir) };
}

export async function runDogfood(configFile: string, dataDir: string): Promise<DogfoodRun> {
  const config = await readJson<DogfoodConfig>(configFile, { sites: [] });
  if (config.sites.length === 0) throw new Error(`No sites were configured in '${configFile}'.`);

  const stateFile = path.join(dataDir, "state.json");
  const previous = await readJson<DogfoodState>(stateFile, {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    sites: {},
  });
  const sites: SiteRunResult[] = [];
  for (const site of config.sites) sites.push(await runSite(site, dataDir, previous));

  const run: DogfoodRun = {
    schemaVersion: 1,
    runAt: new Date().toISOString(),
    sites,
    totals: totalsOf(sites),
  };
  const next: DogfoodState = { schemaVersion: 1, updatedAt: run.runAt, sites: { ...previous.sites } };
  for (const site of sites) {
    const siteSlug = slug(site.name);
    const priorPages = previous.sites[siteSlug]?.pages ?? {};
    const observed = Object.fromEntries(
      site.pages.flatMap((page) => page.observation ? [[page.url, page.observation] as const] : []),
    );
    next.sites[siteSlug] = { baseUrl: site.baseUrl, pages: { ...priorPages, ...observed } };
  }

  await mkdir(path.join(dataDir, "runs"), { recursive: true });
  const stamp = run.runAt.replace(/[:.]/gu, "-");
  await writeJsonAtomic(stateFile, next);
  await writeJsonAtomic(path.join(dataDir, "runs", `${stamp}.json`), run);
  await writeFile(path.join(dataDir, "runs", `${stamp}.md`), markdownReport(run), "utf8");
  return run;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const run = await runDogfood(args.configFile, args.dataDir);
  process.stdout.write(`${markdownReport(run)}\n`);
  if (run.totals.failed > 0) process.exitCode = 1;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Dogfood run failed."}\n`);
    process.exitCode = 1;
  });
}
