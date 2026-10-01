import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";

import { Fetcher } from "../src/fetcher.js";
import { createPublicDispatcher } from "../src/network-policy.js";

import type { LookupFunction } from "node:net";

const options = { timeoutMs: 1_000, minIntervalMs: 0, maxBytes: 1_024, maxRetries: 0, userAgent: "test" };

void test("a stalled resolver cannot outlive the request timeout", async () => {
  const fetcher = new Fetcher({ ...options, timeoutMs: 20,
    createDispatcher: (url, signal) => createPublicDispatcher(url, () => new Promise(() => {}), signal),
  });
  await assert.rejects(() => fetcher.fetch("https://site.test/"), { name: "AbortError" });
});

void test("retry responses dispose their pool and validate a fresh destination", async (t) => {
  const pools: Awaited<ReturnType<typeof createPublicDispatcher>>[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return calls === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
      : new Response("ok");
  });
  const fetcher = new Fetcher({ ...options, maxRetries: 1, createDispatcher: async url => {
    assert.ok(pools.every(pool => pool.destroyed));
    const pool = await createPublicDispatcher(url, async () => [{ address: "93.184.216.34", family: 4 }]);
    pools.push(pool);
    return pool;
  } });
  assert.equal((await fetcher.fetch("https://site.test/")).body, "ok");
  assert.equal(pools.length, 2);
  assert.ok(pools.every(pool => pool.destroyed));
});

for (const protocol of ["http:", "https:"]) {
  void test(`${protocol} socket uses only the validated DNS snapshot`, async (t) => {
    let resolutions = 0;
    const answer = [{ address: "93.184.216.34", family: 4 }];
    const dispatcher = await createPublicDispatcher(`${protocol}//site.test/page`, async () => {
      resolutions += 1;
      return answer;
    });
    // Simulate an adversarial change after validation, including mutation of the
    // resolver's array. Intercept only the OS socket boundary: real fetch and
    // dispatcher code still select the connection options, without network I/O.
    answer[0]!.address = "127.0.0.1";
    let connected = false;
    const connect = (connection: { host: string; servername?: string; lookup: LookupFunction }): net.Socket => {
      connected = true;
      assert.equal(connection.host, "site.test");
      if (protocol === "https:") assert.equal(connection.servername, "site.test");
      assert.equal(typeof connection.lookup, "function");
      connection.lookup("site.test", { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
      });
      connection.lookup("site.test", { family: 4 }, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, "93.184.216.34");
        assert.equal(family, 4);
      });
      connection.lookup("other.test", {}, error => assert.ok(error));
      connection.lookup("site.test", { family: 6 }, error => assert.ok(error));
      const socket = new net.Socket();
      queueMicrotask(() => socket.destroy(new Error("test stops before network I/O")));
      return socket;
    };
    t.mock.method(protocol === "https:" ? tls : net, "connect", connect);
    const fetcher = new Fetcher({ ...options, createDispatcher: async () => dispatcher });
    await assert.rejects(() => fetcher.fetch(`${protocol}//site.test/page`));
    assert.equal(connected, true, "the actual dispatcher must reach the checked connector");
    assert.equal(resolutions, 1, "no second DNS resolution may replace the approved address");
    assert.equal(dispatcher.destroyed, true, "failed requests must release the dispatcher");
  });
}

void test("private, mixed, empty and malformed DNS answers fail before a socket exists", async () => {
  for (const addresses of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }],
    [{ address: "93.184.216.34", family: 6 }],
  ]) {
    await assert.rejects(() => createPublicDispatcher("https://site.test/", async () => addresses));
  }
});

void test("redirects get a new validated dispatcher and release the previous body", async (t) => {
  const prepared: string[] = [];
  const pools: Awaited<ReturnType<typeof createPublicDispatcher>>[] = [];
  let cancelled = false;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { location: "https://site.test/private" },
    });
  });
  const fetcher = new Fetcher({ ...options, createDispatcher: async url => {
    prepared.push(url);
    const pool = await createPublicDispatcher(url, async () => [{
      address: prepared.length === 1 ? "93.184.216.34" : "127.0.0.1", family: 4,
    }]);
    pools.push(pool);
    return pool;
  } });
  await assert.rejects(() => fetcher.fetch("https://site.test/start"), /private or special-use/u);
  assert.deepEqual(prepared, ["https://site.test/start", "https://site.test/private"]);
  assert.equal(requests, 1, "the private redirect must not be fetched");
  assert.equal(cancelled, true);
  assert.ok(pools.every(pool => pool.destroyed));
});
