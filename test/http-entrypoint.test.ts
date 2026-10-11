import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ChildProcess } from "node:child_process";

// Regression test for the HTTP entrypoint. A stateless Streamable HTTP transport
// cannot be reused across requests (SDK 2.3.1 and later), so every request after
// initialize must still succeed as its own HTTP request.

const entrypoint = fileURLToPath(new URL("../src/http.js", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForListening(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited with code ${code}:\n${output}`));
    });
  });
}

void test("HTTP entrypoint serves initialize, tools/list and tools/call as separate requests", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "website-content-http-"));
  const port = await freePort();
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      PATH: process.env.PATH ?? "",
      SITE_BASE_URL: "https://example.invalid/",
      CACHE_DIR: path.join(dir, "cache"),
      HOST: "127.0.0.1",
      PORT: String(port),
      // No origin traffic: skip the startup warm and the periodic refresh.
      STARTUP_REFRESH_LIMIT: "0",
      HTTP_REFRESH_INTERVAL_SECONDS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  });
  await waitForListening(child);

  const url = `http://127.0.0.1:${port}/mcp`;
  const negotiated: { protocolVersion?: string } = {};
  let nextId = 1;
  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(negotiated.protocolVersion ? { "mcp-protocol-version": negotiated.protocolVersion } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Leave the raw text in place for the assertion message.
    }
    return { status: response.status, body };
  }

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-regression-test", version: "1.0.0" },
  });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  negotiated.protocolVersion = (init.body as { result: { protocolVersion: string } }).result.protocolVersion;

  const list = await rpc("tools/list");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const tools = (list.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("content_health"), `tools/list returned ${tools.join(", ")}`);
  assert.ok(!tools.includes("content_refresh"), "content_refresh must stay off on public HTTP by default");

  const call = await rpc("tools/call", { name: "content_health", arguments: {} });
  assert.equal(call.status, 200, JSON.stringify(call.body));
  const result = (call.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0]?.text ?? "", /example\.invalid/u);

  const concurrent = await Promise.all([rpc("tools/list"), rpc("tools/call", { name: "content_health", arguments: {} })]);
  for (const response of concurrent) {
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
});
