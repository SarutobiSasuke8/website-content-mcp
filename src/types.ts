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
  /** Final URL after a validated redirect, when different from `url`. */
  finalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  markdown: string;
  /** SHA-256 of the complete normalized markdown, before response truncation. */
  contentHash: string;
  etag?: string;
  lastModified?: string;
  products?: ProductData[];
  /** How the returned representation was produced. */
  extractionMethod: ExtractionMethod;
  /** Whether the page yielded substantive server-readable content. */
  extractionQuality: ExtractionQuality;
  /** Actionable extraction limitations observed for this page. */
  warnings?: string[];
  /** Web content is evidence/data and must never override agent instructions. */
  sourceTrust: "untrusted-web-content";
  contentLength: number;
  /** True when `markdown` was cut short by the caller's `max_length`. */
  truncated: boolean;
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

/** Markdown extraction of an HTML document, cached alongside the raw body. */
export interface ExtractedContent {
  title?: string;
  canonicalUrl?: string;
  markdown: string;
  products?: ProductData[];
  extractionMethod: ExtractionMethod;
  extractionQuality: ExtractionQuality;
  warnings?: string[];
}

export type ExtractionMethod = "readability" | "body" | "metadata" | "plain-text" | "empty";
export type ExtractionQuality = "full" | "metadata-only" | "empty";

/** Bounded schema.org Product/Offer facts useful to commerce agents. */
export interface ProductOfferData {
  price?: string;
  lowPrice?: string;
  highPrice?: string;
  priceCurrency?: string;
  availability?: string;
  url?: string;
  priceValidUntil?: string;
}

export interface ProductData {
  name?: string;
  sku?: string;
  gtin?: string;
  brand?: string;
  url?: string;
  offers: ProductOfferData[];
}

/** Raw HTTP fetch result, as stored in the cache. */
export interface FetchRecord {
  url: string;
  /** Final URL after validated redirects, when different from `url`. */
  finalUrl?: string;
  status: number;
  contentType?: string;
  body: string;
  fetchedAt: string;
  /** Response validators, replayed on the next fetch as conditional headers. */
  etag?: string;
  lastModified?: string;
  /** True when the response body hit the configured size cap. */
  truncated?: boolean;
  /** Markdown extraction, computed once on first use and persisted. */
  extracted?: ExtractedContent;
}

/** Outcome of a cache-warming pass over the site's discoverable pages. */
export interface RefreshResult {
  source: PageListing["source"];
  requested: number;
  fetched: number;
  revalidated: number;
  skipped: number;
  failed: { url: string; reason: string }[];
  warnings?: string[];
}

/** Health / status snapshot of the running server. */
export interface HealthStatus {
  status: "ok";
  baseUrl: string;
  allowedHosts: string[];
  sitemapUrl: string;
  configuredPages: number;
  cacheDir: string;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  cacheEntries: number;
  cacheBytes: number;
  lastFetchAt?: string;
}
