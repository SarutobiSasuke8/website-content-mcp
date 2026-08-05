import type { FetchRecord } from "./types.js";

export interface FetcherOptions {
  timeoutMs: number;
  minIntervalMs: number;
  userAgent: string;
}

/**
 * Rate-limited HTTP fetcher.
 *
 * Requests to the target site are serialized and spaced by at least
 * `minIntervalMs` (default 1s → max 1 request/second) to stay polite. Each
 * request has a hard timeout via AbortController.
 */
export class Fetcher {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;

  public constructor(private readonly options: FetcherOptions) {}

  private async pace(): Promise<void> {
    const wait = this.lastStart + this.options.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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

  public fetch(url: string): Promise<FetchRecord> {
    return this.enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "user-agent": this.options.userAgent, accept: "text/html,application/xhtml+xml,text/plain,*/*" },
        });
        const body = await response.text();
        const contentType = response.headers.get("content-type") ?? undefined;
        const record: FetchRecord = {
          url,
          status: response.status,
          body,
          fetchedAt: new Date().toISOString(),
        };
        if (contentType) record.contentType = contentType;
        return record;
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
