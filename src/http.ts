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

import type { ErrorRequestHandler } from "express";

const config = loadConfig();
const { service } = createRuntime(config);

const mcpServer = createContentMcpServer(service, {
  allowRefresh: config.httpAllowRefresh,
  exposeCachePath: false,
  backgroundRefreshLimit: config.startupRefreshLimit,
  backgroundRefreshIntervalSeconds: config.httpRefreshIntervalSeconds,
});
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await mcpServer.connect(transport);

const app = createMcpExpressApp({ host: config.host, jsonLimit: "1mb" });
app.set("trust proxy", config.httpTrustedProxies.length > 0 ? config.httpTrustedProxies : false);
app.disable("x-powered-by");
app.use(helmet({ strictTransportSecurity: false, contentSecurityPolicy: false }));

app.get("/healthz", (_request, response) => {
  response.json({ status: "ok", service: "website-content-mcp" });
});

app.all("/mcp", createIpRateLimitMiddleware({
  windowMs: config.httpRateLimitWindowMs,
  maxRequests: config.httpRateLimitMaxRequests,
}), async (request, response) => {
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
  await mcpServer.close();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
