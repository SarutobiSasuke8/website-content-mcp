import { DiskCache } from "./cache.js";
import { normalizeHost } from "./config.js";
import { Fetcher } from "./fetcher.js";
import { createPublicDispatcher } from "./network-policy.js";
import { ContentService } from "./service.js";
import { SnapshotStore } from "./snapshots.js";

import type { AppConfig } from "./config.js";
import type { FetcherOptions } from "./fetcher.js";

/** Whether a redirect hop stays on the same site and never drops from https to http. */
export function redirectAllowed(from: string, to: string): boolean {
  try {
    const source = new URL(from);
    const target = new URL(to);
    if (source.protocol === "https:" && target.protocol === "http:") return false;
    return normalizeHost(source.host) === normalizeHost(target.host);
  } catch {
    return false;
  }
}

export function createRuntime(config: AppConfig): { cache: DiskCache; fetcher: Fetcher; service: ContentService; snapshots: SnapshotStore | undefined } {
  const cache = new DiskCache(config.cacheDir, config.cacheTtlSeconds, config.cacheMaxEntries);
  const fetcherOptions: FetcherOptions = {
    timeoutMs: config.fetchTimeoutMs,
    minIntervalMs: config.fetchMinIntervalMs,
    maxBytes: config.fetchMaxBytes,
    maxRetries: config.fetchMaxRetries,
    userAgent: config.userAgent,
    isRedirectAllowed: redirectAllowed,
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
  const snapshots = config.snapshotMaxEntries > 0
    ? new SnapshotStore(config.snapshotDir, {
      retentionDays: config.snapshotRetentionDays,
      maxEntries: config.snapshotMaxEntries,
      maxMarkdownChars: config.snapshotMaxMarkdownChars,
    })
    : undefined;
  const service = new ContentService(config, cache, fetcher, snapshots);
  return { cache, fetcher, service, snapshots };
}
