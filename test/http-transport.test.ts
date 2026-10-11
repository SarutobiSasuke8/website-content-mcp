import assert from "node:assert/strict";
import { Agent, createServer, request } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } from "../src/http-transport.js";

import type { AddressInfo } from "node:net";

async function checkSocketReuse(
  keepAliveTimeout: number,
  headersTimeout: number,
  idleDelayMs: number,
  expectedConnections: number,
): Promise<void> {
  const server = createServer((_request, response) => response.end("ok"));
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = headersTimeout;
  let connections = 0;
  server.on("connection", () => { connections += 1; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const agent = new Agent({ keepAlive: true });

  const post = (method: string): Promise<void> => new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/mcp",
      method: "POST",
      agent,
      headers: { "Content-Type": "application/json" },
    }, (response) => {
      response.resume();
      response.once("end", resolve);
    });
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify({ method }));
  });

  try {
    await post("initialize");
    await delay(idleDelayMs);
    await post("tools/list");
    assert.equal(connections, expectedConnections);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

void test("the previous 5-second keep-alive closes a setup socket after its Node buffer", { timeout: 15_000 }, async () => {
  await checkSocketReuse(5_000, 35_000, 6_250, 2);
});

void test("an MCP client can reuse its socket between initialize and tools/list after 6.25 seconds", { timeout: 15_000 }, async () => {
  await checkSocketReuse(HTTP_KEEP_ALIVE_TIMEOUT_MS, HTTP_HEADERS_TIMEOUT_MS, 6_250, 1);
});
