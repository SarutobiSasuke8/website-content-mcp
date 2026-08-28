import assert from "node:assert/strict";
import test from "node:test";

import { compareObservation } from "../scripts/dogfood.js";

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
