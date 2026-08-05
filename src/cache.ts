import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FetchRecord } from "./types.js";

/** Deterministic on-disk key for a URL. */
export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * Simple TTL disk cache for fetched pages.
 *
 * Records are stored as JSON files named by the SHA-256 of their URL. Reads
 * prefer a fresh cache entry; expired entries are treated as a miss (but left
 * on disk so a caller can still fall back to them if a live fetch fails).
 */
export class DiskCache {
  public constructor(
    private readonly cacheDir: string,
    private readonly ttlSeconds: number,
  ) {}

  private filePath(url: string): string {
    return path.join(this.cacheDir, `${cacheKey(url)}.json`);
  }

  private isFresh(record: FetchRecord, now: number): boolean {
    if (this.ttlSeconds === 0) return false;
    const age = (now - new Date(record.fetchedAt).getTime()) / 1_000;
    return age >= 0 && age < this.ttlSeconds;
  }

  /** Read a record from disk regardless of freshness, or undefined if absent. */
  public async read(url: string): Promise<FetchRecord | undefined> {
    const file = this.filePath(url);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(await readFile(file, "utf8")) as FetchRecord;
    } catch {
      return undefined;
    }
  }

  /** Read a record only if it exists and is within the TTL. */
  public async get(url: string, now: number = Date.now()): Promise<FetchRecord | undefined> {
    const record = await this.read(url);
    if (record && this.isFresh(record, now)) return record;
    return undefined;
  }

  public async set(record: FetchRecord): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.filePath(record.url), JSON.stringify(record), "utf8");
  }

  /** All cached records (fresh or stale), used for search and stats. */
  public async all(): Promise<FetchRecord[]> {
    if (!existsSync(this.cacheDir)) return [];
    const files = (await readdir(this.cacheDir)).filter((name) => name.endsWith(".json"));
    const records: FetchRecord[] = [];
    for (const name of files) {
      try {
        const raw = await readFile(path.join(this.cacheDir, name), "utf8");
        records.push(JSON.parse(raw) as FetchRecord);
      } catch {
        // Skip unreadable/corrupt entries rather than failing the whole read.
      }
    }
    return records;
  }

  public async stats(): Promise<{ entries: number; bytes: number; lastFetchAt?: string }> {
    if (!existsSync(this.cacheDir)) return { entries: 0, bytes: 0 };
    const files = (await readdir(this.cacheDir)).filter((name) => name.endsWith(".json"));
    let bytes = 0;
    let lastFetchAt: string | undefined;
    for (const name of files) {
      const full = path.join(this.cacheDir, name);
      bytes += (await stat(full)).size;
      try {
        const record = JSON.parse(await readFile(full, "utf8")) as FetchRecord;
        if (!lastFetchAt || record.fetchedAt > lastFetchAt) lastFetchAt = record.fetchedAt;
      } catch {
        // ignore corrupt entries for stats
      }
    }
    return lastFetchAt ? { entries: files.length, bytes, lastFetchAt } : { entries: files.length, bytes };
  }
}
