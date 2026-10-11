import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";

import type { AddressInfo } from "node:net";

import { createIpRateLimitMiddleware } from "../src/http-rate-limit.js";

async function withRateLimitedServer(trustedProxies: string[], run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.set("trust proxy", trustedProxies.length > 0 ? trustedProxies : false);
  app.all("/mcp", createIpRateLimitMiddleware({ windowMs: 60_000, maxRequests: 1 }), (request, response) => {
    response.json({ ip: request.ip });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function post(url: string, forwardedFor: string): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "X-Forwarded-For": forwardedFor } });
}

void test("untrusted X-Forwarded-For cannot bypass the per-IP limit and 429 has Retry-After", async () => {
  await withRateLimitedServer([], async (url) => {
    const first = await post(url, "198.51.100.1");
    assert.equal(first.status, 200);

    const second = await post(url, "198.51.100.2");
    assert.equal(second.status, 429);
    assert.equal((await second.json() as { error: string }).error, "rate_limited");
    assert.ok(Number(second.headers.get("retry-after")) >= 1);
  });
});

void test("X-Forwarded-For separates clients only when the socket proxy is trusted", async () => {
  await withRateLimitedServer(["loopback"], async (url) => {
    assert.equal((await post(url, "198.51.100.1")).status, 200);
    assert.equal((await post(url, "198.51.100.2")).status, 200);
    const repeated = await post(url, "198.51.100.1");
    assert.equal(repeated.status, 429);
  });
});
