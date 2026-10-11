import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

void test("HTTP security and cache refresh defaults are enabled", () => {
  const config = loadConfig({ SITE_BASE_URL: "https://site.test" } as NodeJS.ProcessEnv);
  assert.equal(config.httpRateLimitWindowMs, 60_000);
  assert.equal(config.httpRateLimitMaxRequests, 60);
  assert.deepEqual(config.httpTrustedProxies, []);
  assert.equal(config.startupRefreshLimit, 50);
  assert.equal(config.httpRefreshIntervalSeconds, 300);
});

void test("HTTP proxy and rate settings are configurable", () => {
  const config = loadConfig({
    SITE_BASE_URL: "https://site.test",
    HTTP_TRUST_PROXY: "loopback, 10.0.0.0/8",
    HTTP_RATE_LIMIT_WINDOW_MS: "30000",
    HTTP_RATE_LIMIT_MAX_REQUESTS: "25",
    STARTUP_REFRESH_LIMIT: "12",
    HTTP_REFRESH_INTERVAL_SECONDS: "600",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(config.httpTrustedProxies, ["loopback", "10.0.0.0/8"]);
  assert.equal(config.httpRateLimitWindowMs, 30_000);
  assert.equal(config.httpRateLimitMaxRequests, 25);
  assert.equal(config.startupRefreshLimit, 12);
  assert.equal(config.httpRefreshIntervalSeconds, 600);
});
