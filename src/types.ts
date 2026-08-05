/** A page discovered on the target site. */
export interface PageListing {
  url: string;
  title?: string;
  lastModified?: string;
  priority?: number;
  source: "sitemap" | "robots" | "configured";
}

/** Clean, agent-readable representation of a single page. */
export interface PageContent {
  url: string;
  canonicalUrl?: string;
  title?: string;
  markdown: string;
  contentLength: number;
  fetchedAt: string;
  fromCache: boolean;
}

/** A single search hit over cached content. */
export interface SearchHit {
  url: string;
  title?: string;
  score: number;
  snippet: string;
}

/** One entry in a parsed sitemap. */
export interface SitemapEntry {
  url: string;
  lastModified?: string;
  priority?: number;
  changeFrequency?: string;
}

/** Raw HTTP fetch result, as stored in the cache. */
export interface FetchRecord {
  url: string;
  status: number;
  contentType?: string;
  body: string;
  fetchedAt: string;
}

/** Health / status snapshot of the running server. */
export interface HealthStatus {
  status: "ok";
  baseUrl: string;
  sitemapUrl: string;
  configuredPages: number;
  cacheDir: string;
  cacheTtlSeconds: number;
  cacheEntries: number;
  cacheBytes: number;
  lastFetchAt?: string;
}
