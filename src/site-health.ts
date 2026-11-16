import { JSDOM } from "jsdom";

import { normalizeHost } from "./config.js";

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export interface HealthFinding {
  severity: Severity;
  /** Stable check name, for example `missing-title`. */
  check: string;
  url: string;
  detail: string;
  /** Other URLs involved, such as the pages sharing a duplicate title. */
  related?: string[];
}

/** What one HTML page tells us for the checks that need no other page. */
export interface PageAudit {
  title?: string;
  hasMetaDescription: boolean;
  canonical?: string;
  hasJsonLd: boolean;
  h1Count: number;
  /** Absolute same-site link targets, without fragments, in document order. */
  internalLinks: string[];
}

const ASSET_EXTENSION = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|pdf|zip|gz|mp4|mp3|webm|woff2?|ttf|otf|txt|rss|atom)$/iu;

/** Compare URLs ignoring scheme, `www.`, query, fragment and a trailing slash. */
export function comparableUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return `${normalizeHost(url.host)}${pathname}`;
  } catch {
    return raw;
  }
}

export function auditHtml(html: string, pageUrl: string, siteHost: string): PageAudit {
  const doc = new JSDOM(html, { url: pageUrl }).window.document;
  const title = doc.querySelector("title")?.textContent?.replace(/\s+/gu, " ").trim();
  const description = doc.querySelector('meta[name="description" i]')?.getAttribute("content")?.trim();
  const canonicalHref = doc.querySelector('link[rel~="canonical" i]')?.getAttribute("href")?.trim();

  let canonical: string | undefined;
  if (canonicalHref) {
    try {
      canonical = new URL(canonicalHref, pageUrl).toString();
    } catch {
      canonical = canonicalHref;
    }
  }

  let hasJsonLd = false;
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? "");
      if (parsed && typeof parsed === "object") hasJsonLd = true;
    } catch {
      // Invalid JSON-LD does not count as structured data.
    }
  }

  const links: string[] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data|sms):/iu.test(href)) continue;
    if (/\bnofollow\b/iu.test(anchor.getAttribute("rel") ?? "")) continue;
    try {
      const target = new URL(href, pageUrl);
      if (target.protocol !== "http:" && target.protocol !== "https:") continue;
      if (normalizeHost(target.host) !== siteHost) continue;
      if (ASSET_EXTENSION.test(target.pathname)) continue;
      target.hash = "";
      const text = target.toString();
      if (!seen.has(text)) {
        seen.add(text);
        links.push(text);
      }
    } catch {
      // An unparseable href is not an internal link we can check.
    }
  }

  return {
    ...(title ? { title } : {}),
    hasMetaDescription: Boolean(description),
    ...(canonical ? { canonical } : {}),
    hasJsonLd,
    h1Count: doc.querySelectorAll("h1").length,
    internalLinks: links,
  };
}

/** Per-page findings from an audit, excluding checks that compare pages. */
export function pageFindings(url: string, audit: PageAudit): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const add = (severity: Severity, check: string, detail: string): void => {
    findings.push({ severity, check, url, detail });
  };
  if (!audit.title) add("high", "missing-title", "The page has no title.");
  if (audit.h1Count === 0) add("high", "missing-h1", "The page has no H1 heading.");
  if (audit.h1Count > 1) add("medium", "multiple-h1", `The page has ${audit.h1Count} H1 headings.`);
  if (!audit.hasMetaDescription) add("medium", "missing-meta-description", "The page has no meta description.");
  if (!audit.canonical) {
    add("medium", "missing-canonical", "The page declares no canonical URL.");
  } else if (comparableUrl(audit.canonical) !== comparableUrl(url)) {
    add("high", "canonical-not-self", `The canonical URL points to ${audit.canonical}.`);
  }
  if (!audit.hasJsonLd) add("low", "missing-json-ld", "The page has no valid JSON-LD structured data.");
  return findings;
}

/** Groups of pages that share the same title. */
export function duplicateTitleFindings(titles: Map<string, string>): HealthFinding[] {
  const byTitle = new Map<string, string[]>();
  for (const [url, title] of titles) {
    const key = title.toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), url]);
  }
  const findings: HealthFinding[] = [];
  for (const urls of byTitle.values()) {
    if (urls.length < 2) continue;
    for (const url of urls) {
      findings.push({
        severity: "high",
        check: "duplicate-title",
        url,
        detail: `${urls.length} pages share the title "${titles.get(url) ?? ""}".`,
        related: urls.filter((other) => other !== url).slice(0, 10),
      });
    }
  }
  return findings;
}

export function looksLikeAsset(url: string): boolean {
  try {
    return ASSET_EXTENSION.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
