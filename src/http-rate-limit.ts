import type { RequestHandler } from "express";

interface WindowState {
  count: number;
  resetAt: number;
}

export interface IpRateLimitOptions {
  windowMs: number;
  maxRequests: number;
  /** Bound memory if a client sends requests from many distinct source IPs. */
  maxTrackedIps?: number;
}

/** Fixed-window inbound limiter. IP resolution is delegated to Express `req.ip`. */
export function createIpRateLimitMiddleware(options: IpRateLimitOptions): RequestHandler {
  const maxTrackedIps = options.maxTrackedIps ?? 10_000;
  const clients = new Map<string, WindowState>();

  function removeExpired(now: number): void {
    for (const [ip, state] of clients) {
      if (state.resetAt <= now) clients.delete(ip);
    }
  }

  return (request, response, next) => {
    const now = Date.now();
    const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
    let state = clients.get(ip);

    if (!state || state.resetAt <= now) {
      if (!state && clients.size >= maxTrackedIps) removeExpired(now);
      if (!state && clients.size >= maxTrackedIps) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil(options.windowMs / 1_000))));
        response.status(429).json({ error: "rate_limited", message: "Too many requests; retry after the indicated delay." });
        return;
      }
      state = { count: 0, resetAt: now + options.windowMs };
      clients.set(ip, state);
    }

    if (state.count >= options.maxRequests) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - now) / 1_000))));
      response.status(429).json({ error: "rate_limited", message: "Too many requests; retry after the indicated delay." });
      return;
    }

    state.count += 1;
    next();
  };
}
