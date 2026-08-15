import path from "node:path";

import { z } from "zod";

/**
 * Environment configuration for the website content MCP server.
 *
 * Only `SITE_BASE_URL` is required. Everything else has a sensible default so
 * the server is safe to run locally against public content out of the box.
 */
const envSchema = z.object({
  SITE_BASE_URL: z.string().url(),
  SITE_SITEMAP_URL: z.string().url().optional(),
  SITE_PAGES: z.string().optional(),
  SITE_ALLOWED_HOSTS: z.string().optional(),
  CACHE_DIR: z.string().default(".cache"),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(2_592_000).default(3_600),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).max(100_000).default(500),
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  FETCH_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
  FETCH_MAX_BYTES: z.coerce.number().int().min(1_024).max(50_000_000).default(5_000_000),
  FETCH_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  USER_AGENT: z.string().default("website-content-mcp/0.2 (+https://github.com/SarutobiSasuke8/website-content-mcp)"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_215),
});

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export interface AppConfig {
  baseUrl: string;
  /** Hosts this server may fetch from. Always includes the base URL's host. */
  allowedHosts: string[];
  sitemapUrl: string;
  configuredPages: string[];
  cacheDir: string;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  fetchTimeoutMs: number;
  fetchMinIntervalMs: number;
  fetchMaxBytes: number;
  fetchMaxRetries: number;
  userAgent: string;
  host: string;
  port: number;
}

/**
 * Resolve a possibly-relative page reference against the configured base URL.
 * Absolute URLs are returned unchanged.
 */
export function resolveUrl(baseUrl: string, ref: string): string {
  return new URL(ref, baseUrl).toString();
}

/**
 * Normalize a host for comparison: lowercase, and with a leading `www.` treated
 * as equivalent to the bare domain.
 */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./u, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const base = new URL(parsed.SITE_BASE_URL);
  const baseUrl = base.toString();
  const sitemapUrl = parsed.SITE_SITEMAP_URL
    ? new URL(parsed.SITE_SITEMAP_URL).toString()
    : new URL("/sitemap.xml", baseUrl).toString();
  const configuredPages = csv(parsed.SITE_PAGES).map((page) => resolveUrl(baseUrl, page));

  // The base host is always allowed; extra hosts are opt-in. A configured
  // sitemap on another host is allowed implicitly, since it was named by the
  // operator rather than discovered from remote content.
  const allowedHosts = [
    ...new Set([
      normalizeHost(base.host),
      normalizeHost(new URL(sitemapUrl).host),
      ...csv(parsed.SITE_ALLOWED_HOSTS).map(normalizeHost),
    ]),
  ];

  return {
    baseUrl,
    allowedHosts,
    sitemapUrl,
    configuredPages,
    cacheDir: path.resolve(parsed.CACHE_DIR),
    cacheTtlSeconds: parsed.CACHE_TTL_SECONDS,
    cacheMaxEntries: parsed.CACHE_MAX_ENTRIES,
    fetchTimeoutMs: parsed.FETCH_TIMEOUT_MS,
    fetchMinIntervalMs: parsed.FETCH_MIN_INTERVAL_MS,
    fetchMaxBytes: parsed.FETCH_MAX_BYTES,
    fetchMaxRetries: parsed.FETCH_MAX_RETRIES,
    userAgent: parsed.USER_AGENT,
    host: parsed.HOST,
    port: parsed.PORT,
  };
}
