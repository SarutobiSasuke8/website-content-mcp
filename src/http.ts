#!/usr/bin/env node
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import helmet from "helmet";

import { loadConfig } from "./config.js";
import { createIpRateLimitMiddleware } from "./http-rate-limit.js";
import { HttpRefreshScheduler } from "./http-refresh.js";
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } from "./http-transport.js";
import { createRuntime } from "./runtime.js";
import { createContentMcpServer } from "./server.js";

import type { McpServer } from "@modelcontextprotocol/server";
import type { ErrorRequestHandler, Request, Response } from "express";

const config = loadConfig();
const { service } = createRuntime(config);

const serverOptions = {
  allowRefresh: config.httpAllowRefresh,
  exposeCachePath: false,
  backgroundRefreshLimit: config.startupRefreshLimit,
  backgroundRefreshIntervalSeconds: config.httpRefreshIntervalSeconds,
};
// Stateless Streamable HTTP: the SDK does not reuse a stateless transport across
// requests, so each request gets its own server and transport, closed when the
// response closes. The content service and its cache are shared.
const openServers = new Set<McpServer>();

const app = createMcpExpressApp({ host: config.host, jsonLimit: "1mb" });
app.set("trust proxy", config.httpTrustedProxies.length > 0 ? config.httpTrustedProxies : false);
app.disable("x-powered-by");
app.use(helmet({ strictTransportSecurity: false, contentSecurityPolicy: false }));

app.get("/healthz", (_request, response) => {
  response.json({ status: "ok", service: "website-content-mcp" });
});

app.get("/robots.txt", (_request, response) => {
  response.setHeader("X-Robots-Tag", "noindex");
  response.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

function isPlainBrowserGet(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.accept ?? "";
  return !accept.includes("text/event-stream");
}

function sendPlainMcpInfo(request: Request, response: Response): void {
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (request.method === "HEAD") {
    response.status(200).end();
    return;
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex, nofollow">
  <title>Website Content MCP</title>
</head>
<body>
  <h1>Website Content MCP</h1>
  <p>This is a Streamable HTTP <strong>MCP endpoint for MCP clients</strong> (Claude, ChatGPT connectors, and other MCP-aware tools). It is not a human web page.</p>
  <p>MCP clients must send <code>Accept: text/event-stream</code> (or the appropriate Streamable HTTP headers) and use POST for initialize / tools calls.</p>
  <p>Human readers: see <a href="https://astraeus.ie/">https://astraeus.ie/</a> and <a href="https://astraeus.ie/llms.txt">https://astraeus.ie/llms.txt</a>.</p>
</body>
</html>`;
  response.status(200).type("html").send(html);
}

app.all("/mcp", createIpRateLimitMiddleware({
  windowMs: config.httpRateLimitWindowMs,
  maxRequests: config.httpRateLimitMaxRequests,
}), async (request, response) => {
  if (isPlainBrowserGet(request)) {
    sendPlainMcpInfo(request, response);
    return;
  }
  const mcpServer = createContentMcpServer(service, serverOptions);
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  openServers.add(mcpServer);
  response.on("close", () => {
    openServers.delete(mcpServer);
    void mcpServer.close();
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(request, response, request.body);
});

app.use((_request, response) => {
  response.status(404).json({ error: "not_found" });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  process.stderr.write(`Request failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  if (!response.headersSent) response.status(500).json({ error: "internal_server_error" });
};
app.use(errorHandler);

const httpServer = app.listen(config.port, config.host, () => {
  process.stdout.write(`website-content-mcp listening on http://${config.host}:${config.port}/mcp (site: ${config.baseUrl})\n`);
});
const refreshScheduler = new HttpRefreshScheduler(
  service,
  config.startupRefreshLimit,
  config.httpRefreshIntervalSeconds * 1_000,
);
refreshScheduler.start();
httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
// Leave a full minute for MCP clients to make their next call over a reused
// socket, with headersTimeout beyond Node's keep-alive timeout buffer.
httpServer.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;

async function shutdown(): Promise<void> {
  refreshScheduler.stop();
  httpServer.close();
  await Promise.allSettled([...openServers].map((server) => server.close()));
  openServers.clear();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
