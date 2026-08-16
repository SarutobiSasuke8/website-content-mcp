import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

import type { ExtractedContent, ProductData, ProductOfferData } from "./types.js";

export type { ExtractedContent };

const NON_CONTENT_TAGS = ["script", "style", "noscript", "nav", "footer", "header", "aside", "form", "iframe"];
const MAX_PRODUCTS = 20;
const MAX_OFFERS_PER_PRODUCT = 20;
const MAX_JSON_LD_NODES = 200;
const MAX_JSON_LD_DEPTH = 10;
const MAX_STRUCTURED_TEXT_LENGTH = 2_048;

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_STRUCTURED_TEXT_LENGTH);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function typesOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function jsonLdNodes(value: unknown, depth = 0, budget = { remaining: MAX_JSON_LD_NODES }): Record<string, unknown>[] {
  if (depth > MAX_JSON_LD_DEPTH || budget.remaining <= 0) return [];
  if (Array.isArray(value)) {
    const nodes: Record<string, unknown>[] = [];
    for (const entry of value) {
      nodes.push(...jsonLdNodes(entry, depth + 1, budget));
      if (budget.remaining <= 0) break;
    }
    return nodes;
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  budget.remaining -= 1;
  const graph = record["@graph"];
  return graph === undefined ? [record] : [record, ...jsonLdNodes(graph, depth + 1, budget)];
}

function offerOf(value: unknown): ProductOfferData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const offer: ProductOfferData = {};
  const fields: [keyof ProductOfferData, string][] = [
    ["price", "price"],
    ["lowPrice", "lowPrice"],
    ["highPrice", "highPrice"],
    ["priceCurrency", "priceCurrency"],
    ["availability", "availability"],
    ["url", "url"],
    ["priceValidUntil", "priceValidUntil"],
  ];
  for (const [target, key] of fields) {
    const value = textValue(source[key]);
    if (value !== undefined) offer[target] = value;
  }
  return Object.keys(offer).length > 0 ? offer : undefined;
}

function productOf(node: Record<string, unknown>): ProductData | undefined {
  if (!typesOf(node["@type"]).some((type) => type.toLowerCase() === "product")) return undefined;
  const product: ProductData = { offers: [] };
  const name = textValue(node.name);
  const sku = textValue(node.sku);
  const url = textValue(node.url);
  const gtin = textValue(node.gtin)
    ?? textValue(node.gtin8)
    ?? textValue(node.gtin12)
    ?? textValue(node.gtin13)
    ?? textValue(node.gtin14);
  if (name) product.name = name;
  if (sku) product.sku = sku;
  if (url) product.url = url;
  if (gtin) product.gtin = gtin;

  const brand = node.brand;
  const brandName = textValue(brand)
    ?? (brand && typeof brand === "object" && !Array.isArray(brand)
      ? textValue((brand as Record<string, unknown>).name)
      : undefined);
  if (brandName) product.brand = brandName;

  const rawOffers = Array.isArray(node.offers) ? node.offers : node.offers === undefined ? [] : [node.offers];
  product.offers = rawOffers.slice(0, MAX_OFFERS_PER_PRODUCT)
    .map(offerOf)
    .filter((offer): offer is ProductOfferData => offer !== undefined);

  return product;
}

function extractProducts(doc: Document): ProductData[] {
  const products: ProductData[] = [];
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    if (products.length >= MAX_PRODUCTS) break;
    const source = script.textContent?.trim();
    if (!source) continue;
    try {
      const parsed: unknown = JSON.parse(source);
      for (const node of jsonLdNodes(parsed)) {
        const product = productOf(node);
        if (product) products.push(product);
        if (products.length >= MAX_PRODUCTS) break;
      }
    } catch {
      // Invalid JSON-LD must not prevent normal page extraction.
    }
  }
  return products;
}

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
  const products = extractProducts(doc);

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
  if (products.length > 0) result.products = products;
  return result;
}
