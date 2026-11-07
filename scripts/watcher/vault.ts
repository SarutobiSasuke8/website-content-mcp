import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { materialChanges } from "./report.js";
import { nextReportPath } from "./run.js";

import type { RunResult } from "./run.js";

export interface VaultFeedOptions {
  /** Root of the Obsidian vault. */
  vaultDir: string;
  /** Report what would be written and write nothing. */
  dryRun?: boolean;
}

export interface VaultFeedResult {
  /** Vault note written, when at least one page changed. */
  notePath?: string;
  /** Task lines appended to the inbox. */
  tasks: string[];
  messages: string[];
}

/** Where run notes go. Business/Companies is never touched. */
export const WATCHER_OUTPUT_DIR = ["Portfolio", "Dev", "MCP Servers", "Watcher Output"] as const;
export const INBOX_FILE = ["Tasks", "Inbox.md"] as const;

/**
 * Make page-derived or watchlist text safe on a single task line. It removes
 * everything that could add a tag (so nothing can add `#next`), an inline field,
 * a wikilink, a comment, a code span or maths, and every emoji or symbol the
 * Tasks plugin reads as a due, scheduled, start, priority or recurrence marker.
 */
export function taskText(text: string, max = 200): string {
  const cleaned = text
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}]/gu, "")
    .replace(/‍|︎|️/gu, "")
    .replace(/\p{C}/gu, " ")
    .replace(/[[\]]/gu, (bracket) => (bracket === "[" ? "(" : ")"))
    .replace(/[#%`$^@＠]/gu, "")
    .replace(/::/gu, ":")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * Identifies one change on one day. The description holds the old and new
 * values, so a price that later returns to an earlier value is a new change.
 */
export function changeId(url: string, description: string, runDay: string): string {
  return createHash("sha256").update(`${url}\n${description}\n${runDay}`).digest("hex").slice(0, 10);
}

/** Ids of tasks that are still open (not ticked) in the inbox text. */
export function openTaskIds(inboxText: string): Set<string> {
  const ids = new Set<string>();
  for (const line of inboxText.split(/\r?\n/u)) {
    if (!/^\s*[-*]\s+\[ \]/u.test(line)) continue;
    for (const match of line.matchAll(/\[watcher:: ([0-9a-f]{10})\]/gu)) if (match[1]) ids.add(match[1]);
  }
  return ids;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Write the run's report into the vault as one dated note and append one task
 * line per material change to the inbox. Does nothing when no page changed.
 */
export async function writeVaultFeed(result: RunResult, options: VaultFeedOptions): Promise<VaultFeedResult> {
  const feed: VaultFeedResult = { tasks: [], messages: [] };
  if (result.changed === 0 || !result.reportMarkdown) {
    feed.messages.push("Vault feed: no pages changed, so nothing was written to the vault.");
    return feed;
  }

  const vault = path.resolve(options.vaultDir);
  const inbox = path.join(vault, ...INBOX_FILE);
  const outputDir = path.join(vault, ...WATCHER_OUTPUT_DIR);
  if (!isInside(vault, outputDir) || !isInside(vault, inbox)) throw new Error("Vault paths must stay inside the vault.");
  if (!existsSync(inbox)) {
    throw new Error(`'${inbox}' does not exist, so '${vault}' does not look like the vault. Nothing was written.`);
  }

  const runDay = result.runDate.toISOString().slice(0, 10);
  const notePath = await nextReportPath(outputDir, result.runDate);
  const noteName = path.basename(notePath, ".md");
  const link = [...WATCHER_OUTPUT_DIR, noteName].join("/");

  const existingInbox = await readFile(inbox, "utf8");
  const eol = existingInbox.includes("\r\n") ? "\r\n" : "\n";
  const lines: string[] = [];
  const open = openTaskIds(existingInbox);
  for (const { entry, change } of materialChanges(result.results)) {
    const id = changeId(entry.url, change.description, runDay);
    // Skip a task that is already open, including one written earlier in this same run.
    if (open.has(id)) continue;
    open.add(id);
    const project = entry.project ? ` [project:: ${taskText(entry.project, 80)}]` : "";
    lines.push(`- [ ] Review ${taskText(entry.label, 80)} (${entry.kind}): ${taskText(change.description)}${project} [created:: ${runDay}] [watcher:: ${id}] #task #inbox`);
  }
  feed.tasks = lines;
  feed.notePath = notePath;

  const section = lines.length > 0
    ? [
      "",
      `## Website watcher changes, ${runDay}`,
      "",
      `Source: [[${link}]]. Material changes only; the note lists everything that changed.`,
      "",
      ...lines,
      "",
    ].join(eol)
    : "";

  if (options.dryRun) {
    feed.messages.push(`Vault feed (dry run): would write ${notePath}`);
    feed.messages.push(`Vault feed (dry run): would append ${lines.length} task line(s) to ${inbox}`);
    for (const line of lines) feed.messages.push(`  ${line}`);
    return feed;
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(notePath, result.reportMarkdown, { encoding: "utf8", flag: "wx" });
  if (section) {
    const separator = existingInbox.endsWith("\n") ? "" : eol;
    await appendFile(inbox, `${separator}${section}`, "utf8");
  }
  feed.messages.push(`Vault feed: wrote ${notePath}`);
  feed.messages.push(`Vault feed: appended ${lines.length} task line(s) to ${inbox}`);
  return feed;
}
