import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ContentService } from "./service.js";

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

const urlInput = z.string().trim().min(1).max(2_048);

/** Default cap on returned markdown, so one long page cannot swamp a context. */
const DEFAULT_MAX_LENGTH = 50_000;

export function createContentMcpServer(service: ContentService): McpServer {
  const server = new McpServer({ name: "website-content-mcp", version: "0.2.0" });

  server.registerTool(
    "content_health",
    {
      title: "Content server health",
      description: "Report server status: configured site, sitemap URL, cache directory, cache size and last fetch time.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => runTool(async () => ({ health: await service.health() })),
  );

  server.registerTool(
    "content_list_pages",
    {
      title: "List discoverable pages",
      description:
        "List pages discoverable on the configured site. Prefers sitemap.xml, then sitemaps advertised in robots.txt, then the configured page list. Returns URL, title and last-modified when known.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(1_000).default(100),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit }) => runTool(async () => await service.listPages(limit)),
  );

  server.registerTool(
    "content_get_page",
    {
      title: "Get page as markdown",
      description:
        "Fetch a page URL (absolute, or relative to the configured base URL), strip it to clean markdown and return content plus metadata (title, canonical URL, fetched_at, content length). Only fetches the configured site's host. Respects robots.txt.",
      inputSchema: z.object({
        url: urlInput,
        max_length: z.number().int().min(500).max(500_000).default(DEFAULT_MAX_LENGTH)
          .describe("Maximum markdown characters to return. `content_length` always reports the full size."),
        refresh: z.boolean().default(false)
          .describe("Bypass the cache TTL and revalidate against the origin."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async ({ url, max_length, refresh }) =>
      runTool(async () => ({ page: await service.getPage(url, { maxLength: max_length, refresh }) })),
  );

  server.registerTool(
    "content_refresh",
    {
      title: "Warm the content cache",
      description:
        "Walk the site's discoverable pages and fetch them into the cache, so content_search has something to search. Rate-limited to ~1 request/second, so a large limit takes a while. Skips robots-disallowed pages.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(50)
          .describe("Maximum pages to fetch this pass."),
        force: z.boolean().default(false)
          .describe("Revalidate even pages that are still within the cache TTL."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, force }) => runTool(async () => ({ refresh: await service.refresh(limit, force) })),
  );

  server.registerTool(
    "content_search",
    {
      title: "Search cached content",
      description:
        "Keyword search over already-fetched/cached pages. Returns matching URLs with a relevance score and a text snippet. The cache starts empty: run content_refresh once to populate it, or fetch individual pages with content_get_page.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, limit }) => runTool(async () => ({ query, results: await service.search(query, limit) })),
  );

  server.registerTool(
    "content_get_sitemap",
    {
      title: "Get sitemap structure",
      description: "Return the raw sitemap structure for the configured site: URLs with last-modified, priority and change frequency when present.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => runTool(async () => await service.getSitemap()),
  );

  return server;
}
