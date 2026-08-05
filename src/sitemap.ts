import { JSDOM } from "jsdom";

import type { SitemapEntry } from "./types.js";

export interface ParsedSitemap {
  /** Page entries from a `<urlset>` sitemap. */
  entries: SitemapEntry[];
  /** Nested sitemap URLs from a `<sitemapindex>` (to be fetched separately). */
  sitemaps: string[];
}

function text(element: Element, tag: string): string | undefined {
  const node = element.getElementsByTagName(tag)[0];
  const value = node?.textContent?.trim();
  return value ? value : undefined;
}

/**
 * Parse a sitemap XML document. Handles both `<urlset>` (page listings) and
 * `<sitemapindex>` (nested sitemaps) forms. Malformed XML yields empty results
 * rather than throwing, so page discovery can fall through to other sources.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  const result: ParsedSitemap = { entries: [], sitemaps: [] };
  let doc: Document;
  try {
    doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  } catch {
    return result;
  }

  for (const url of Array.from(doc.getElementsByTagName("url"))) {
    const loc = text(url, "loc");
    if (!loc) continue;
    const lastModified = text(url, "lastmod");
    const priorityRaw = text(url, "priority");
    const changeFrequency = text(url, "changefreq");
    const priority = priorityRaw === undefined ? undefined : Number(priorityRaw);
    const entry: SitemapEntry = { url: loc };
    if (lastModified) entry.lastModified = lastModified;
    if (priority !== undefined && Number.isFinite(priority)) entry.priority = priority;
    if (changeFrequency) entry.changeFrequency = changeFrequency;
    result.entries.push(entry);
  }

  for (const sitemap of Array.from(doc.getElementsByTagName("sitemap"))) {
    const loc = text(sitemap, "loc");
    if (loc) result.sitemaps.push(loc);
  }

  return result;
}
