import assert from "node:assert/strict";
import test from "node:test";

import { contentSearchDescription } from "../src/server.js";

void test("public HTTP search wording describes automatic refresh without naming a hidden tool", () => {
  const description = contentSearchDescription({
    allowRefresh: false,
    backgroundRefreshLimit: 50,
    backgroundRefreshIntervalSeconds: 300,
  });
  assert.match(description, /refreshed automatically every 300 seconds/u);
  assert.match(description, /last_refresh_at/u);
  assert.doesNotMatch(description, /content_refresh/u);
});

void test("stdio search wording names content_refresh only when the tool is exposed", () => {
  const description = contentSearchDescription({
    allowRefresh: true,
    backgroundRefreshLimit: 0,
    backgroundRefreshIntervalSeconds: 0,
  });
  assert.match(description, /content_refresh/u);
});

void test("public HTTP search wording explains when automatic refresh is disabled", () => {
  const description = contentSearchDescription({
    allowRefresh: false,
    backgroundRefreshLimit: 0,
    backgroundRefreshIntervalSeconds: 300,
  });
  assert.match(description, /Automatic refresh is disabled/u);
  assert.doesNotMatch(description, /content_refresh/u);
});
