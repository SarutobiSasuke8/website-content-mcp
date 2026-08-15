import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import type { ExtractedContent } from "./types.js";

export type { ExtractedContent };

const NON_CONTENT_TAGS = ["script", "style", "noscript", "nav", "footer", "header", "aside", "form", "iframe"];

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  });
  // Drop anything that survived extraction but carries no reader value.
  service.remove(["script", "style", "noscript", "iframe"]);
  return service;
}

function normalize(markdown: string): string {
  return markdown
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert a full HTML document to clean, agent-readable markdown.
 *
 * Uses Mozilla Readability to isolate the main article. When Readability cannot
 * find an article (small or unusual pages), it falls back to stripping known
 * non-content elements from the body and converting whatever remains. Parsing
 * is done with a real DOM (jsdom) — never with regex.
 */
export function htmlToMarkdown(html: string, url?: string): ExtractedContent {
  const dom = url ? new JSDOM(html, { url }) : new JSDOM(html);
  const doc = dom.window.document;

  const docTitle = doc.querySelector("title")?.textContent?.trim();
  const canonicalUrl = doc.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() || undefined;

  const turndown = createTurndown();

  // Strip non-content chrome up front so it can never leak into the output,
  // regardless of whether Readability or the fallback path produces the markdown.
  for (const tag of NON_CONTENT_TAGS) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) el.remove();
  }

  // Readability mutates the document it is given, so run it on a clone and keep
  // the cleaned original DOM available for the fallback path.
  const readabilityDoc = dom.window.document.cloneNode(true) as Document;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(readabilityDoc).parse();
  } catch {
    article = null;
  }

  let markdown: string;
  let title = docTitle;
  if (article?.content && article.content.trim()) {
    markdown = turndown.turndown(article.content);
    if (article.title?.trim()) title = article.title.trim();
  } else {
    const body = doc.body?.innerHTML ?? "";
    markdown = turndown.turndown(body);
  }

  const result: ExtractedContent = { markdown: normalize(markdown) };
  if (title) result.title = title;
  if (canonicalUrl) result.canonicalUrl = canonicalUrl;
  return result;
}
