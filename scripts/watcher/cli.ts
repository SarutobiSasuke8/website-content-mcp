#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";

import { PACKAGE_VERSION } from "../../src/version.js";
import { runWatcher } from "./run.js";
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
  /** No page changed, but at least one page could not be checked. */
  ERRORS: 3,
} as const;

export const HELP = `website-content-watcher ${PACKAGE_VERSION}

Check a watchlist of pages, keep snapshots, and write a Markdown report of the
pages that changed. It reuses the website-content-mcp fetcher, so it respects
robots.txt, the per-host rate limit and the site allowlist taken from the
watchlist. Deterministic only: no language model is involved.

Usage:
  website-content-watcher --watchlist watchlist.yaml --out ./watcher-output [options]

Options:
  --watchlist <file>        YAML or JSON watchlist (default: watchlist.yaml)
  --out <dir>               Snapshots, reports and HTTP cache live here (default: ./watcher-output)
  --dry-run                 Fetch and compare but write nothing; print the report instead
  --min-interval-ms <n>     Minimum milliseconds between requests to one host (default: 1000)
  --allow-private-network   Permit hosts that resolve to private addresses (local test sites only)
  --quiet                   Print only the final summary line
  --help                    Show this help

Exit codes:
  0  nothing changed (first-time baselines count as unchanged)
  1  fatal error, such as a bad watchlist or arguments
  2  at least one page changed
  3  nothing changed but at least one page could not be checked
`;

export function exitCodeFor(result: Pick<RunResult, "changed" | "errors">): number {
  if (result.changed > 0) return EXIT.CHANGED;
  if (result.errors > 0) return EXIT.ERRORS;
  return EXIT.OK;
}

export function describeRun(result: RunResult): string[] {
  const lines: string[] = [];
  for (const entry of result.results) {
    const note = entry.status === "error"
      ? `error: ${entry.error ?? "unknown"}`
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

export async function main(argv: string[], io: CliIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        watchlist: { type: "string", default: "watchlist.yaml" },
        out: { type: "string", default: "watcher-output" },
        "dry-run": { type: "boolean", default: false },
        "min-interval-ms": { type: "string" },
        "allow-private-network": { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : "Invalid arguments"}\n\n${HELP}`);
    return EXIT.FATAL;
  }
  if (values.help) {
    io.out(HELP);
    return EXIT.OK;
  }

  try {
    const minInterval = values["min-interval-ms"];
    if (minInterval !== undefined && !/^\d{1,5}$/u.test(minInterval)) throw new Error("--min-interval-ms must be a whole number of milliseconds.");
    const watchlist = await loadWatchlist(path.resolve(values.watchlist));
    const result = await runWatcher({
      watchlist,
      outputDir: values.out,
      dryRun: values["dry-run"],
      ...(minInterval !== undefined ? { minIntervalMs: Number(minInterval) } : {}),
      allowPrivateNetwork: values["allow-private-network"],
    });

    if (!values.quiet) for (const line of describeRun(result)) io.out(line);
    if (result.dryRun && result.reportMarkdown) {
      io.out("\n--- dry run: report that would be written ---\n");
      io.out(result.reportMarkdown);
    }
    const watched = result.results.length;
    io.out(
      `${result.dryRun ? "[dry run] " : ""}${watched} watched: ${result.changed} changed, ${result.baselined} baselined, ${result.unchanged} unchanged, ${result.errors} errors.${result.reportPath ? ` Report: ${result.reportPath}` : ""}`,
    );
    for (const entry of result.results) {
      if (entry.status === "error") io.err(`Could not check ${entry.entry.url}: ${entry.error ?? "unknown error"}`);
    }
    return exitCodeFor(result);
  } catch (error) {
    io.err(`Watcher failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return EXIT.FATAL;
  }
}

// Run only when started as a program, not when imported by tests.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).replace(/\.(?:ts|js)$/u, "") === path.resolve(import.meta.filename).replace(/\.(?:ts|js)$/u, "");
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
