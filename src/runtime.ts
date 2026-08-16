import { DiskCache } from "./cache.js";
import { normalizeHost } from "./config.js";
import { Fetcher } from "./fetcher.js";
import { ContentService } from "./service.js";

import type { AppConfig } from "./config.js";

export function createRuntime(config: AppConfig): { cache: DiskCache; fetcher: Fetcher; service: ContentService } {
  const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
  const fetcher = new Fetcher({
    timeoutMs: config.fetchTimeoutMs,
    minIntervalMs: config.fetchMinIntervalMs,
    maxBytes: config.fetchMaxBytes,
    maxRetries: config.fetchMaxRetries,
    userAgent: config.userAgent,
    isUrlAllowed: (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        return (url.protocol === "http:" || url.protocol === "https:")
          && config.allowedHosts.includes(normalizeHost(url.host));
      } catch {
        return false;
      }
    },
  });
  const service = new ContentService(config, cache, fetcher);
  return { cache, fetcher, service };
}
