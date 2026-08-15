import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cacheKey, DiskCache } from "../src/cache.js";

import type { FetchRecord } from "../src/types.js";

function record(url: string, fetchedAt: string): FetchRecord {
  return { url, status: 200, contentType: "text/html", body: `<html><body>${url}</body></html>`, fetchedAt };
}

void test("cacheKey is deterministic and url-specific", () => {
  assert.equal(cacheKey("https://example.com/a"), cacheKey("https://example.com/a"));
  assert.notEqual(cacheKey("https://example.com/a"), cacheKey("https://example.com/b"));
});

void test("set/get round-trips a fresh record and misses when absent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-cache-"));
  try {
    const cache = new DiskCache(dir, 3_600);
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    await cache.set(record("https://example.com/", new Date(now).toISOString()));

    const hit = await cache.get("https://example.com/", now + 1_000);
    assert.ok(hit);
    assert.equal(hit?.status, 200);
    assert.equal(await cache.get("https://example.com/missing", now), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("get honors TTL but read still returns the stale record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-cache-"));
  try {
    const cache = new DiskCache(dir, 3_600);
    const fetchedAt = new Date(Date.parse("2026-08-04T00:00:00.000Z")).toISOString();
    await cache.set(record("https://example.com/old", fetchedAt));

    const twoHoursLater = Date.parse("2026-08-04T02:00:00.000Z");
    assert.equal(await cache.get("https://example.com/old", twoHoursLater), undefined, "expired entry is a miss");
    const stale = await cache.read("https://example.com/old");
    assert.ok(stale, "stale entry is still readable for fallback");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("stats report entry count, byte size and newest fetch time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-cache-"));
  try {
    const cache = new DiskCache(dir, 3_600);
    await cache.set(record("https://example.com/a", "2026-08-04T00:00:00.000Z"));
    await cache.set(record("https://example.com/b", "2026-08-04T01:00:00.000Z"));

    const stats = await cache.stats();
    assert.equal(stats.entries, 2);
    assert.ok(stats.bytes > 0);
    assert.equal(stats.lastFetchAt, "2026-08-04T01:00:00.000Z");
    assert.equal((await cache.all()).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("prune evicts oldest entries beyond maxEntries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-cache-"));
  try {
    const cache = new DiskCache(dir, 3_600, 2);
    await cache.set(record("https://example.com/old", "2026-08-01T00:00:00.000Z"));
    await cache.set(record("https://example.com/mid", "2026-08-02T00:00:00.000Z"));
    await cache.set(record("https://example.com/new", "2026-08-03T00:00:00.000Z"));

    const stats = await cache.stats();
    assert.equal(stats.entries, 2, "cache stays within its bound");
    assert.equal(await cache.read("https://example.com/old"), undefined, "oldest entry is evicted");
    assert.ok(await cache.read("https://example.com/new"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("maxEntries of zero leaves the cache unbounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-cache-"));
  try {
    const cache = new DiskCache(dir, 3_600, 0);
    for (let i = 0; i < 5; i++) {
      await cache.set(record(`https://example.com/${i}`, `2026-08-0${i + 1}T00:00:00.000Z`));
    }
    assert.equal((await cache.stats()).entries, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("ttl of zero always misses (cache disabled)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcm-cache-"));
  try {
    const cache = new DiskCache(dir, 0);
    const now = Date.parse("2026-08-04T00:00:00.000Z");
    await cache.set(record("https://example.com/", new Date(now).toISOString()));
    assert.equal(await cache.get("https://example.com/", now), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
