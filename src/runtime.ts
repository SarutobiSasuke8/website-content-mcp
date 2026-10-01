import { DiskCache } from "./cache.js";
import { normalizeHost } from "./config.js";
import { Fetcher } from "./fetcher.js";
import { createPublicDispatcher } from "./network-policy.js";
import { ContentService } from "./service.js";

import type { AppConfig } from "./config.js";
import type { FetcherOptions } from "./fetcher.js";

export function createRuntime(config: AppConfig): { cache: DiskCache; fetcher: Fetcher; service: ContentService } {
  const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
  const fetcherOptions: FetcherOptions = {
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
  };
  if (!config.fetchAllowPrivateNetwork) {
    fetcherOptions.createDispatcher = (url, signal) => createPublicDispatcher(url, undefined, signal);
  }
  const fetcher = new Fetcher(fetcherOptions);
  const service = new ContentService(config, cache, fetcher);
  return { cache, fetcher, service };
}
