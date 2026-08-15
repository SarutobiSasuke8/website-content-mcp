import type { FetchRecord } from "./types.js";

export interface FetcherOptions {
  timeoutMs: number;
  minIntervalMs: number;
  maxBytes: number;
  maxRetries: number;
  userAgent: string;
}

/** Cache validators replayed as conditional request headers. */
export interface ConditionalHeaders {
  etag?: string;
  lastModified?: string;
}

/** Longest we will honour a `Retry-After` before giving up on the wait. */
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_BACKOFF_MS = 1_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

function retryDelayMs(retryAfter: string | null): number {
  if (!retryAfter) return DEFAULT_BACKOFF_MS;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  return DEFAULT_BACKOFF_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rate-limited HTTP fetcher.
 *
 * Requests to the target site are serialized and spaced by at least
 * `minIntervalMs` (default 1s → max 1 request/second) to stay polite. Each
 * request has a hard timeout via AbortController, a hard body size cap, and a
 * bounded retry that honours `Retry-After` on 429/503.
 */
export class Fetcher {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  public constructor(private readonly options: FetcherOptions) {}

  private async pace(): Promise<void> {
    const wait = this.lastStart + this.options.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
  }

  /** Serialize a task behind the rate-limit gate. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await this.pace();
      return task();
    });
    // Keep the chain alive even if this task rejects.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Read a response body, stopping hard at `maxBytes` so one oversized page
   * cannot exhaust memory or fill the cache.
   */
  private async readBody(response: Response): Promise<{ body: string; truncated: boolean }> {
    if (!response.body) return { body: "", truncated: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    let truncated = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        let chunk = value;
        if (bytes + chunk.byteLength > this.options.maxBytes) {
          chunk = chunk.subarray(0, Math.max(0, this.options.maxBytes - bytes));
          truncated = true;
        }
        bytes += chunk.byteLength;
        body += decoder.decode(chunk, { stream: true });
        if (truncated) break;
      }
      body += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return { body, truncated };
  }

  private async fetchOnce(
    url: string,
    conditional: ConditionalHeaders,
  ): Promise<{ record: FetchRecord; retryAfter: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent": this.options.userAgent,
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
      };
      if (conditional.etag) headers["if-none-match"] = conditional.etag;
      if (conditional.lastModified) headers["if-modified-since"] = conditional.lastModified;

      const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers });
      // A 304 carries no body; the caller reuses its cached copy.
      const { body, truncated } = response.status === 304
        ? { body: "", truncated: false }
        : await this.readBody(response);

      const record: FetchRecord = { url, status: response.status, body, fetchedAt: new Date().toISOString() };
      const contentType = response.headers.get("content-type");
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      if (contentType) record.contentType = contentType;
      // Validators are only trustworthy for a body we stored in full.
      if (etag && !truncated) record.etag = etag;
      if (lastModified && !truncated) record.lastModified = lastModified;
      if (truncated) record.truncated = true;

      return { record, retryAfter: response.headers.get("retry-after") };
    } finally {
      clearTimeout(timer);
    }
  }

  public fetch(url: string, conditional: ConditionalHeaders = {}): Promise<FetchRecord> {
    return this.enqueue(async () => {
      let attempt = 0;
      for (;;) {
        const { record, retryAfter } = await this.fetchOnce(url, conditional);
        if (!RETRYABLE_STATUSES.has(record.status) || attempt >= this.options.maxRetries) return record;
        attempt += 1;
        await sleep(retryDelayMs(retryAfter));
      }
    });
  }
}
