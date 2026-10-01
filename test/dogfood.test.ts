import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareObservation, parseArgs } from "../scripts/dogfood.js";

void test("invalid CLI arguments cannot silently start a default crawl", () => {
  for (const args of [["--typo"], ["--config"], ["--data-dir", "--config", "file.json"]]) {
    assert.throws(() => parseArgs(args), /Unknown argument|Missing value/u);
  }
});

const observation = {
  url: "https://site.test/a",
  contentHash: "a".repeat(64),
  contentLength: 10,
  extractionMethod: "body",
  extractionQuality: "full",
  fetchedAt: "2026-08-28T10:00:00.000Z",
  fromCache: false,
};

void test("dogfood comparison distinguishes baseline, unchanged and changed pages", () => {
  assert.equal(compareObservation(undefined, observation), "baseline");
  assert.equal(compareObservation(observation, { ...observation, fetchedAt: "2026-08-28T11:00:00.000Z" }), "unchanged");
  assert.equal(compareObservation(observation, { ...observation, contentHash: "b".repeat(64) }), "changed");
});

void test("installed CLI finds its bundled config from an unrelated working directory", () => {
  const caller = path.join(os.tmpdir(), "website-content-operator");
  const args = parseArgs([], caller);
  assert(existsSync(args.configFile), "default configuration must be shipped with the package");
  assert.equal(args.dataDir, path.join(caller, ".dogfood-data"));
  assert(!args.configFile.startsWith(caller));
});

void test("explicit CLI configuration and evidence paths are relative to the caller", () => {
  const caller = path.join(os.tmpdir(), "website-content-operator");
  const args = parseArgs(["--config", "sites.json", "--data-dir", "evidence"], caller);
  assert.equal(args.configFile, path.join(caller, "sites.json"));
  assert.equal(args.dataDir, path.join(caller, "evidence"));
});
