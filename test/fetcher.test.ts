import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { Fetcher } from "../src/fetcher.js";

const options = {
  timeoutMs: 5_000,
  minIntervalMs: 0,
  maxBytes: 1_000_000,
  maxRetries: 1,
  userAgent: "test-agent/1.0",
};

/** Swap in a stubbed global fetch for the duration of a test. */
async function withFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
  run: (calls: { url: string; init: RequestInit }[]) => Promise<void>,
): Promise<void> {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  }) as unknown as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
    mock.reset();
  }
}

void test("fetch caps the body at maxBytes and marks the record truncated", async () => {
  const huge = "x".repeat(50_000);
  await withFetch(
    () => Promise.resolve(new Response(huge, { status: 200, headers: { "content-type": "text/html", etag: 'W/"big"' } })),
    async () => {
      const fetcher = new Fetcher({ ...options, maxBytes: 1_000 });
      const record = await fetcher.fetch("https://site.test/big");

      assert.equal(record.truncated, true);
      assert.equal(record.body.length, 1_000);
      assert.equal(record.etag, undefined, "validators are dropped for a partial body");
    },
  );
});

void test("fetch leaves an under-cap body intact and keeps its validators", async () => {
  await withFetch(
    () =>
      Promise.resolve(
        new Response("<html><body>small</body></html>", {
          status: 200,
          headers: { "content-type": "text/html", etag: 'W/"ok"', "last-modified": "Wed, 13 Aug 2026 10:00:00 GMT" },
        }),
      ),
    async () => {
      const record = await new Fetcher(options).fetch("https://site.test/small");
      assert.equal(record.truncated, undefined);
      assert.match(record.body, /small/u);
      assert.equal(record.etag, 'W/"ok"');
      assert.equal(record.lastModified, "Wed, 13 Aug 2026 10:00:00 GMT");
    },
  );
});

void test("fetch sends conditional headers when validators are supplied", async () => {
  await withFetch(
    // 304 is a null-body status; Response rejects a body here, as a real one would.
    () => Promise.resolve(new Response(null, { status: 304 })),
    async (calls) => {
      const record = await new Fetcher(options).fetch("https://site.test/a", {
        etag: 'W/"a1"',
        lastModified: "Wed, 13 Aug 2026 10:00:00 GMT",
      });

      const headers = calls[0]?.init.headers as Record<string, string>;
      assert.equal(headers["if-none-match"], 'W/"a1"');
      assert.equal(headers["if-modified-since"], "Wed, 13 Aug 2026 10:00:00 GMT");
      assert.equal(record.status, 304);
      assert.equal(record.body, "");
    },
  );
});

void test("fetch retries once on 429 and honours Retry-After", async () => {
  let served = 0;
  await withFetch(
    () => {
      served += 1;
      return Promise.resolve(
        served === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
          : new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    },
    async (calls) => {
      const record = await new Fetcher(options).fetch("https://site.test/rate-limited");
      assert.equal(calls.length, 2, "the 429 is retried exactly once");
      assert.equal(record.status, 200);
      assert.match(record.body, /ok/u);
    },
  );
});

void test("fetch gives up after maxRetries and returns the last response", async () => {
  await withFetch(
    () => Promise.resolve(new Response("nope", { status: 503, headers: { "retry-after": "0" } })),
    async (calls) => {
      const record = await new Fetcher({ ...options, maxRetries: 2 }).fetch("https://site.test/down");
      assert.equal(calls.length, 3, "one initial attempt plus two retries");
      assert.equal(record.status, 503);
    },
  );
});

void test("fetch spaces requests by minIntervalMs", async () => {
  await withFetch(
    () => Promise.resolve(new Response("ok", { status: 200 })),
    async () => {
      const fetcher = new Fetcher({ ...options, minIntervalMs: 120 });
      const started = Date.now();
      await Promise.all([
        fetcher.fetch("https://site.test/1"),
        fetcher.fetch("https://site.test/2"),
        fetcher.fetch("https://site.test/3"),
      ]);
      assert.ok(Date.now() - started >= 240, "three requests wait out two intervals");
    },
  );
});

void test("fetch follows an allowed redirect and records the final URL", async () => {
  await withFetch(
    (url) => Promise.resolve(
      url === "https://site.test/start"
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("<html><body>done</body></html>", { status: 200 }),
    ),
    async (calls) => {
      const fetcher = new Fetcher({
        ...options,
        isUrlAllowed: (url) => new URL(url).hostname === "site.test",
      });
      const record = await fetcher.fetch("https://site.test/start");
      assert.equal(calls.length, 2);
      assert.equal(record.url, "https://site.test/start");
      assert.equal(record.finalUrl, "https://site.test/final");
      assert.equal(record.status, 200);
    },
  );
});

void test("fetch refuses a redirect outside the configured host allowlist", async () => {
  await withFetch(
    () => Promise.resolve(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })),
    async (calls) => {
      const fetcher = new Fetcher({
        ...options,
        isUrlAllowed: (url) => new URL(url).hostname === "site.test",
      });
      await assert.rejects(
        () => fetcher.fetch("https://site.test/start"),
        /outside the configured host allowlist/u,
      );
      assert.equal(calls.length, 1, "the disallowed redirect target must never reach the network");
    },
  );
});
