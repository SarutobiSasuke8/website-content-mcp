#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { PriceHistoryStore, priceHistoryCsv } from "../../src/price-history.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import { collectComparison, renderComparison, vaultComparisonDirectory, writeComparison } from "./compare.js";
import { buildDigest, digestFromDirectory, vaultDigestDirectory, writeDigest } from "./digest.js";
import { HISTORY_DIR, runWatcher } from "./run.js";
import { loadWatchlist } from "./watchlist.js";

import type { RunResult } from "./run.js";

/** Process exit codes. */
export const EXIT = {
  /** Every page was checked and nothing changed (first-time baselines count as no change). */
  OK: 0,
  /** Bad arguments, an unreadable watchlist or another fatal problem. */
  FATAL: 1,
  /** At least one page changed. */
  CHANGED: 2,
  /** No page changed, but at least one page could not be checked or observed. */
  ERRORS: 3,
} as const;

export const HELP = `website-content-watcher ${PACKAGE_VERSION}

Check a watchlist of pages, keep snapshots and a price history, and write a
Markdown report of the pages that changed. It reuses the website-content-mcp
fetcher, so it respects robots.txt, the per-host rate limit and the site
allowlist taken from the watchlist. Deterministic only: no language model is
involved.

Usage:
  website-content-watcher [run] --watchlist watchlist.yaml --out ./watcher-output [options]
  website-content-watcher compare --watchlist watchlist.yaml --out ./watcher-output [--vault <dir>]
  website-content-watcher digest --out ./watcher-output [--vault <dir>] [--days 7] [--expect-runs 1]
  website-content-watcher history --out ./watcher-output [--csv <file>] [--plan <name>] [--since <date>]

Commands:
  run        Fetch the watchlist, compare with the stored snapshots and write a report (default)
  compare    Write one living comparison note of the watched competitors (plans, prices, free tier, calls to action, last change)
  digest     Write a dated summary of the last seven days from the stored events and runs
  history    Print or save the stored price history as CSV

Options:
  --watchlist <file>        YAML or JSON watchlist (default: watchlist.yaml)
  --out <dir>               Snapshots, reports, logs and HTTP cache live here (default: ./watcher-output)
  --dry-run                 Fetch and compare but write nothing; print the result instead
  --vault <dir>             Write notes into an Obsidian vault (run also appends inbox tasks)
  --min-interval-ms <n>     Minimum milliseconds between requests to one host (default: 1000)
  --allow-private-network   Permit hosts that resolve to private addresses (local test sites only)
  --include-own             compare: also list the owner's own pages as reference rows
  --days <n>                digest: days to cover (default: 7)
  --expect-runs <n>         digest: runs the schedule should have produced in the window (default: 1)
  --csv <file>              history: write the CSV here instead of printing it
  --plan <name>, --since <YYYY-MM-DD>   history: filter the rows
  --quiet                   Print only the final summary line
  --help                    Show this help

Exit codes (run):
  0  nothing changed (first-time baselines count as unchanged)
  1  fatal error, such as a bad watchlist or arguments
  2  at least one page changed
  3  nothing changed but at least one page could not be checked or observed
`;

export function exitCodeFor(result: Pick<RunResult, "changed" | "errors"> & { unavailable?: number }): number {
  if (result.changed > 0) return EXIT.CHANGED;
  if (result.errors > 0 || (result.unavailable ?? 0) > 0) return EXIT.ERRORS;
  return EXIT.OK;
}

export function describeRun(result: RunResult): string[] {
  const lines: string[] = [];
  for (const entry of result.results) {
    const note = entry.status === "error" || entry.status === "unavailable"
      ? `${entry.status}: ${entry.error ?? "unknown"}`
      : entry.noiseOnly
        ? "unchanged (date stamps or spacing only)"
        : entry.status;
    lines.push(`${note.padEnd(10)} ${entry.entry.label} <${entry.entry.url}>`);
  }
  return lines;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const COMMANDS = ["run", "compare", "digest", "history"] as const;
type Command = (typeof COMMANDS)[number];

function wholeNumber(name: string, value: string | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,5}$/u.test(value) || Number(value) > max) throw new Error(`--${name} must be a whole number up to ${max}.`);
  return Number(value);
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        watchlist: { type: "string", default: "watchlist.yaml" },
        out: { type: "string", default: "watcher-output" },
        vault: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "min-interval-ms": { type: "string" },
        "allow-private-network": { type: "boolean", default: false },
        "include-own": { type: "boolean", default: false },
        days: { type: "string" },
        "expect-runs": { type: "string" },
        csv: { type: "string" },
        plan: { type: "string" },
        since: { type: "string" },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : "Invalid arguments"}\n\n${HELP}`);
    return EXIT.FATAL;
  }
  if (values.help) {
    io.out(HELP);
    return EXIT.OK;
  }
  const command = (positionals[0] ?? "run") as Command;
  if (!COMMANDS.includes(command) || positionals.length > 1) {
    io.err(`Unknown command '${positionals.join(" ")}'. Use one of: ${COMMANDS.join(", ")}.\n\n${HELP}`);
    return EXIT.FATAL;
  }

  try {
    if (command === "compare") return await compareCommand(values, io);
    if (command === "digest") return await digestCommand(values, io);
    if (command === "history") return await historyCommand(values, io);

    const minInterval = wholeNumber("min-interval-ms", values["min-interval-ms"], 99_999);
    const watchlist = await loadWatchlist(path.resolve(values.watchlist));
    const result = await runWatcher({
      watchlist,
      outputDir: values.out,
      dryRun: values["dry-run"],
      ...(minInterval !== undefined ? { minIntervalMs: minInterval } : {}),
      allowPrivateNetwork: values["allow-private-network"],
    });

    if (!values.quiet) for (const line of describeRun(result)) io.out(line);
    if (result.dryRun && result.reportMarkdown) {
      io.out("\n--- dry run: report that would be written ---\n");
      io.out(result.reportMarkdown);
    }
    if (values.vault) {
      const { writeVaultFeed } = await import("./vault.js");
      const feed = await writeVaultFeed(result, { vaultDir: values.vault, dryRun: values["dry-run"] });
      for (const line of feed.messages) io.out(line);
    }
    const watched = result.results.length;
    io.out(
      `${result.dryRun ? "[dry run] " : ""}${watched} watched: ${result.changed} changed, ${result.baselined} baselined, ${result.unchanged} unchanged, ${result.pending} pending, ${result.errors} errors, ${result.unavailable} unavailable.${result.reportPath ? ` Report: ${result.reportPath}` : ""}`,
    );
    for (const entry of result.results) {
      if (entry.status === "error") io.err(`Could not check ${entry.entry.url}: ${entry.error ?? "unknown error"}`);
      if (entry.status === "unavailable") io.err(`Could not observe ${entry.entry.url} this time: ${entry.error ?? "unknown error"}`);
    }
    return exitCodeFor(result);
  } catch (error) {
    io.err(`Watcher failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return EXIT.FATAL;
  }
}

type Values = Record<string, string | boolean | undefined>;

async function compareCommand(values: Values, io: CliIo): Promise<number> {
  const watchlist = await loadWatchlist(path.resolve(String(values["watchlist"])));
  const rows = await collectComparison(watchlist, String(values["out"]), { includeOwn: values["include-own"] === true });
  const markdown = renderComparison(rows, { includeOwn: values["include-own"] === true });
  if (values["dry-run"] === true) {
    io.out(markdown);
    return EXIT.OK;
  }
  const directory = typeof values["vault"] === "string" ? vaultComparisonDirectory(values["vault"]) : path.resolve(String(values["out"]));
  io.out(`Comparison written to ${await writeComparison(markdown, directory)}`);
  return EXIT.OK;
}

async function digestCommand(values: Values, io: CliIo): Promise<number> {
  const days = wholeNumber("days", typeof values["days"] === "string" ? values["days"] : undefined, 90);
  const expected = wholeNumber("expect-runs", typeof values["expect-runs"] === "string" ? values["expect-runs"] : undefined, 100);
  const digest = await digestFromDirectory(String(values["out"]), {
    ...(days !== undefined ? { days } : {}),
    ...(expected !== undefined ? { expectedRuns: expected } : {}),
  });
  if (values["dry-run"] === true) {
    io.out(digest.markdown);
    return EXIT.OK;
  }
  const directory = typeof values["vault"] === "string" ? vaultDigestDirectory(values["vault"]) : path.join(path.resolve(String(values["out"])), "digests");
  io.out(`Digest written to ${await writeDigest(digest, directory)} (${digest.events} events, ${digest.runs} runs${digest.missedRuns > 0 ? `, ${digest.missedRuns} missed` : ""}).`);
  return EXIT.OK;
}

async function historyCommand(values: Values, io: CliIo): Promise<number> {
  const store = new PriceHistoryStore(path.join(path.resolve(String(values["out"])), ...HISTORY_DIR));
  const csv = priceHistoryCsv(await store.readAll(), {
    ...(typeof values["plan"] === "string" ? { plan: values["plan"] } : {}),
    ...(typeof values["since"] === "string" ? { since: values["since"] } : {}),
  });
  if (typeof values["csv"] === "string") {
    const file = path.resolve(values["csv"]);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, csv, "utf8");
    io.out(`Price history written to ${file} (${csv.split("\n").length - 2} rows).`);
  } else {
    io.out(csv.trimEnd());
  }
  return EXIT.OK;
}

// Keep the digest builder reachable for callers that already hold the logs.
export { buildDigest };

// Run only when started as a program, not when imported by tests.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).replace(/\.(?:ts|js)$/u, "") === path.resolve(import.meta.filename).replace(/\.(?:ts|js)$/u, "");
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
