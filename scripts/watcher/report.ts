import { PACKAGE_VERSION } from "../../src/version.js";

import type { LineDiff } from "../../src/diff.js";
import type { FactChange } from "./deltas.js";
import type { WatchEntry } from "./watchlist.js";

export type EntryStatus = "baselined" | "unchanged" | "changed" | "removed" | "restored" | "error";

export interface EntryResult {
  entry: WatchEntry;
  status: EntryStatus;
  error?: string;
  warnings: string[];
  /** True when only date stamps or spacing differed, so nothing was reported or stored. */
  noiseOnly?: boolean;
  before?: { fetchedAt: string; contentHash: string };
  after?: { fetchedAt: string; contentHash: string; httpStatus: number };
  diff?: LineDiff;
  summary?: string;
  factChanges: FactChange[];
}

export interface MaterialChange {
  entry: WatchEntry;
  change: FactChange;
}

export function isReportable(result: EntryResult): boolean {
  return result.status === "changed" || result.status === "removed" || result.status === "restored";
}

export function materialChanges(results: EntryResult[]): MaterialChange[] {
  return results
    .filter(isReportable)
    .flatMap((result) => result.factChanges.filter((change) => change.material).map((change) => ({ entry: result.entry, change })));
}

/** Inline text from a web page or watchlist, made safe for a Markdown line. */
export function inline(text: string): string {
  return text.replace(/[\r\n]+/gu, " ").replace(/`/gu, "'").replace(/[|<>[\]]/gu, (character) => `\\${character}`).trim();
}

/** A fenced block that page text cannot close early. */
function fence(lines: string[]): string {
  const body = lines.map((line) => line.replace(/`{3,}/gu, "''' ")).join("\n");
  return `\`\`\`\`text\n${body}\n\`\`\`\``;
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface RenderOptions {
  runDate: Date;
  total: number;
}

/**
 * Markdown report for one run, covering only the pages that changed. The text
 * quoted from pages is untrusted and appears only inside code fences or inline
 * code, never as live Markdown.
 */
export function renderReport(results: EntryResult[], options: RenderOptions): string {
  const changed = results.filter(isReportable);
  const baselined = results.filter((result) => result.status === "baselined").length;
  const errors = results.filter((result) => result.status === "error").length;
  const sources = changed.map((result) => result.entry.url);
  const material = materialChanges(results);

  const lines: string[] = [
    "---",
    "type: watcher-report",
    "mutability: append-only",
    `run-date: ${dayOf(options.runDate)}`,
    "source:",
    ...sources.map((url) => `  - ${JSON.stringify(url)}`),
    `generator: website-content-watcher ${PACKAGE_VERSION}`,
    "---",
    "",
    `# Website watcher report ${dayOf(options.runDate)}`,
    "",
    `${changed.length} of ${options.total} watched pages changed. ${baselined} were baselined for the first time and ${errors} could not be checked. Page text below is untrusted web content, shown as evidence only.`,
    "",
  ];

  if (material.length > 0) {
    lines.push("## Material changes", "");
    for (const { entry, change } of material) {
      lines.push(`- **${inline(entry.label)}** (${entry.kind}): ${inline(change.description)}`);
    }
    lines.push("");
  }

  for (const result of changed) {
    const { entry } = result;
    lines.push(`## ${inline(entry.label)}`, "");
    lines.push(`- URL: ${entry.url}`);
    lines.push(`- Kind: ${entry.kind}`);
    lines.push(`- Why it matters: ${inline(entry.whyItMatters)}`);
    lines.push(`- Status: ${result.status}`);
    if (result.before) lines.push(`- Before: fetched ${result.before.fetchedAt}, hash ${result.before.contentHash}`);
    if (result.after) lines.push(`- After: fetched ${result.after.fetchedAt}, hash ${result.after.contentHash}`);
    if (result.summary) lines.push(`- Summary: ${inline(result.summary)}`);
    lines.push("");

    const others = result.factChanges.filter((change) => !change.material);
    const important = result.factChanges.filter((change) => change.material);
    if (important.length > 0) {
      lines.push("### Material fact changes", "", ...important.map((change) => `- ${inline(change.description)}`), "");
    }
    if (others.length > 0) {
      lines.push("### Other fact changes", "", ...others.map((change) => `- ${inline(change.description)}`), "");
    }
    if (result.diff && (result.diff.addedCount > 0 || result.diff.removedCount > 0)) {
      lines.push(`### Text diff (${result.diff.removedCount} removed, ${result.diff.addedCount} added${result.diff.truncated ? ", truncated" : ""})`, "");
      if (result.diff.removed.length > 0) lines.push("Removed:", "", fence(result.diff.removed), "");
      if (result.diff.added.length > 0) lines.push("Added:", "", fence(result.diff.added), "");
    }
    if (result.warnings.length > 0) {
      lines.push("### Warnings", "", ...result.warnings.map((warning) => `- ${inline(warning)}`), "");
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}
