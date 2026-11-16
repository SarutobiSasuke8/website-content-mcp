import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

/** A stored view of one page at one moment. */
export interface SnapshotVersion {
  /** Normalized Markdown, possibly clipped to the store's per-page bound. */
  markdown: string;
  /** SHA-256 of the complete normalized Markdown, before any clipping. */
  contentHash: string;
  /** Key used to decide whether a page changed. Defaults to `contentHash`. */
  compareKey: string;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
  title?: string;
  /** True when `markdown` was clipped for storage; the hash still covers the full text. */
  storedTruncated?: boolean;
  /** Optional structured facts retained by callers such as the watcher. */
  facts?: unknown;
  /** HTTP status when the snapshot was taken; 200 unless the page had gone. */
  status?: number;
}

export interface SnapshotRecord {
  url: string;
  firstSeenAt: string;
  /** When the current version replaced the previous one. */
  changedAt?: string;
  current: SnapshotVersion;
  previous?: SnapshotVersion;
}

export interface SnapshotStoreOptions {
  /** Versions and idle entries older than this many days are removed. */
  retentionDays: number;
  /** Maximum stored URLs; the least recently seen are removed first. */
  maxEntries: number;
  /** Maximum Markdown characters kept per version. */
  maxMarkdownChars: number;
}

export type SnapshotStatus = "first-seen" | "unchanged" | "changed";

export interface SnapshotComparison {
  status: SnapshotStatus;
  /** The stored baseline before this observation; absent on first sight. */
  baseline?: SnapshotVersion;
  /** The observation, clipped for storage. */
  observed: SnapshotVersion;
  /** Whatever was previously stored for the URL. */
  existing?: SnapshotRecord;
}

export type Observation = Omit<SnapshotVersion, "compareKey" | "storedTruncated"> & { compareKey?: string };

const DAY_MS = 86_400_000;

export function snapshotKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Bounded on-disk store of the previous normalized Markdown per URL.
 *
 * One JSON file per URL holds the current baseline and the version it replaced.
 * An unchanged page writes nothing (only the file's modification time is
 * refreshed, so retention can tell the entry is still in use). Retention and
 * entry-count bounds keep the directory from growing without limit.
 */
export class SnapshotStore {
  public constructor(
    private readonly dir: string,
    private readonly options: SnapshotStoreOptions,
  ) {}

  private filePath(url: string): string {
    return path.join(this.dir, `${snapshotKey(url)}.json`);
  }

  public async read(url: string): Promise<SnapshotRecord | undefined> {
    const file = this.filePath(url);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(await readFile(file, "utf8")) as SnapshotRecord;
    } catch {
      return undefined;
    }
  }

  private clip(observation: Observation): SnapshotVersion {
    const version: SnapshotVersion = {
      ...observation,
      compareKey: observation.compareKey ?? observation.contentHash,
    };
    if (version.markdown.length > this.options.maxMarkdownChars) {
      version.markdown = version.markdown.slice(0, this.options.maxMarkdownChars);
      version.storedTruncated = true;
    }
    return version;
  }

  /** Compare an observation with the stored baseline without writing anything. */
  public async compare(url: string, observation: Observation): Promise<SnapshotComparison> {
    const observed = this.clip(observation);
    const existing = await this.read(url);
    if (!existing) return { status: "first-seen", observed };
    const status: SnapshotStatus = existing.current.compareKey === observed.compareKey ? "unchanged" : "changed";
    return { status, baseline: existing.current, observed, existing };
  }

  /** Compare and then persist: a baseline on first sight, a new version on change, nothing otherwise. */
  public async record(url: string, observation: Observation): Promise<SnapshotComparison> {
    const comparison = await this.compare(url, observation);
    if (comparison.status === "unchanged") {
      const now = new Date();
      await utimes(this.filePath(url), now, now).catch(() => undefined);
      return comparison;
    }
    const record: SnapshotRecord = comparison.existing
      ? {
        url,
        firstSeenAt: comparison.existing.firstSeenAt,
        changedAt: comparison.observed.fetchedAt,
        current: comparison.observed,
        previous: comparison.existing.current,
      }
      : { url, firstSeenAt: comparison.observed.fetchedAt, current: comparison.observed };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(url), JSON.stringify(record), "utf8");
    await this.prune();
    return comparison;
  }

  /** Apply the retention and entry-count bounds. Returns the number of files removed. */
  public async prune(now: number = Date.now()): Promise<number> {
    if (!existsSync(this.dir)) return 0;
    const names = (await readdir(this.dir)).filter((name) => name.endsWith(".json"));
    const entries: { file: string; seen: number }[] = [];
    let removed = 0;
    const cutoff = now - this.options.retentionDays * DAY_MS;

    for (const name of names) {
      const file = path.join(this.dir, name);
      const seen = (await stat(file)).mtimeMs;
      if (seen < cutoff) {
        await rm(file, { force: true });
        removed += 1;
        continue;
      }
      entries.push({ file, seen });
      try {
        const record = JSON.parse(await readFile(file, "utf8")) as SnapshotRecord;
        if (record.previous && new Date(record.previous.fetchedAt).getTime() < cutoff) {
          delete record.previous;
          await writeFile(file, JSON.stringify(record), "utf8");
        }
      } catch {
        await rm(file, { force: true });
        removed += 1;
        entries.pop();
      }
    }

    if (this.options.maxEntries > 0 && entries.length > this.options.maxEntries) {
      entries.sort((a, b) => a.seen - b.seen);
      for (const entry of entries.slice(0, entries.length - this.options.maxEntries)) {
        await rm(entry.file, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** Remove the stored baseline for a URL. */
  public async forget(url: string): Promise<void> {
    await rm(this.filePath(url), { force: true });
  }
}
