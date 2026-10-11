import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { HttpRefreshScheduler } from "../src/http-refresh.js";

void test("scheduled refreshes advance through bounded page windows and wrap", async () => {
  const offsets: number[] = [];
  const service = {
    lastRefreshAt: null as string | null,
    async refresh(limit: number, _force: boolean, offset: number) {
      offsets.push(offset);
      const requested = Math.min(limit, Math.max(0, 3 - offset));
      this.lastRefreshAt = new Date().toISOString();
      return { source: "sitemap" as const, requested, fetched: requested, revalidated: 0, skipped: 0, failed: [] };
    },
  };
  const scheduler = new HttpRefreshScheduler(service as never, 2, 20, () => undefined);
  scheduler.start();
  try {
    await delay(100);
  } finally {
    scheduler.stop();
  }
  assert.deepEqual(offsets.slice(0, 3), [0, 2, 0]);
});
