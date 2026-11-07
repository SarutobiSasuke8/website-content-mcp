import { JSDOM } from "jsdom";

import { extractProducts, extractSchemaTypes } from "./content.js";
import { findAmounts } from "./diff.js";
import { extractPricingTable } from "./pricing.js";
import { certificationsOf, heroOf, integrationNamesOf, releasesOf, rolesOf } from "./signals.js";

import type { PricingTable } from "./pricing.js";
import type { HeroFact, ReleaseFact, RoleFact, WatchKind } from "./signals.js";
import type { ProductData } from "./types.js";

/**
 * Bounded structured facts read from a page's HTML.
 *
 * Everything here is observed, never inferred: a value that the page does not
 * state is left out rather than guessed. The page text is untrusted data.
 */
export interface PageFacts {
  title?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  /** H1 to H3 headings in document order. */
  outline?: { level: 1 | 2 | 3; text: string }[];
  /** Buttons and prominent links: visible text with the destination when it has one. */
  callsToAction?: { text: string; href?: string }[];
  pricing?: {
    /** Currency amounts with the text around them and, when a card or section names one, a plan. */
    amounts: PriceSignal[];
    /** Fixed phrases found on the page, such as "free trial" or "request a quote". */
    phrases?: string[];
  };
  /** Plan-level prices: name, price, currency, billing period, unit, free and trial flags, features. */
  pricingTable?: PricingTable;
  /** Positioning: the H1, meta description, first calls to action and lead paragraph. */
  hero?: HeroFact;
  /** Open roles. Read only for careers pages. */
  roles?: RoleFact[];
  /** Integration or partner names. Read only for integration pages. */
  integrations?: string[];
  /** Certifications and trust mechanisms mentioned. Read only for security pages. */
  certifications?: string[];
  /** Version or dated headings. Read only for changelog pages. */
  releases?: ReleaseFact[];
  /** schema.org types declared in JSON-LD, such as Organization or Product. */
  schemaTypes?: string[];
  /** schema.org Product and Offer facts from JSON-LD. */
  products?: ProductData[];
  /** Blog or news entries, present only when the page lists at least two. */
  items?: { title: string; href: string; date?: string }[];
  warnings?: string[];
}

export interface PriceSignal {
  /** The amount as written, without spaces, for example `€49`. */
  amount: string;
  /** Short text around the amount. */
  label: string;
  /** Plan or tier name when the surrounding card or section has a heading. */
  plan?: string;
  /** Billing period when written next to the amount, such as `month`. */
  period?: string;
}

const MAX_OUTLINE = 60;
const MAX_CTAS = 25;
const MAX_PRICES = 40;
const MAX_ITEMS = 30;
const MAX_TEXT = 160;
const MAX_CTA_TEXT = 80;
const MAX_SCHEMA_TYPES = 30;

const PRICE_PHRASES = [
  "free trial",
  "free plan",
  "free forever",
  "no credit card",
  "money-back guarantee",
  "contact sales",
  "contact us for pricing",
  "request a quote",
  "get a quote",
  "custom pricing",
  "book a demo",
  "book a call",
];

const PRICE_TAGS = "p, li, td, th, dt, dd, h1, h2, h3, h4, h5, h6, span, div, strong, b, em, a, label, button";
const CTA_CLASS = /(?:^|[\s_-])(?:btn|button|cta)(?:$|[\s_-])/iu;
const PERIOD = /(?:\/\s*|\bper\s+|\ba\s+|\beach\s+)(month|mo|year|yr|week|day|user|seat|project|hour)\b|\b(monthly|annually|yearly|one[- ]?off|one[- ]?time)\b/iu;
const DATE_TEXT = /\b(\d{4}-\d{2}-\d{2})\b|\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4})\b|\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/iu;

function norm(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/gu, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function absolute(href: string | null, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || /^(?:javascript|data|vbscript):/iu.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function outlineOf(doc: Document): PageFacts["outline"] {
  const outline: { level: 1 | 2 | 3; text: string }[] = [];
  for (const heading of Array.from(doc.querySelectorAll("h1, h2, h3"))) {
    const text = norm(heading.textContent);
    if (!text) continue;
    outline.push({ level: Number(heading.tagName.slice(1)) as 1 | 2 | 3, text: clip(text, MAX_TEXT) });
    if (outline.length >= MAX_OUTLINE) break;
  }
  return outline;
}

function ctasOf(doc: Document, base: string): { text: string; href?: string }[] {
  const seen = new Set<string>();
  const result: { text: string; href?: string }[] = [];
  const candidates = doc.querySelectorAll(
    'button:not([type="reset"]), [role="button"], input[type="submit"], input[type="button"], a[href][class], a[href][data-cta]',
  );
  for (const element of Array.from(candidates)) {
    const tag = element.tagName.toLowerCase();
    const isAnchor = tag === "a";
    const prominent = !isAnchor
      || element.getAttribute("role") === "button"
      || element.hasAttribute("data-cta")
      || CTA_CLASS.test(element.getAttribute("class") ?? "");
    if (!prominent) continue;
    const text = norm(tag === "input" ? element.getAttribute("value") : element.textContent || element.getAttribute("aria-label"));
    if (!text || text.length > MAX_CTA_TEXT) continue;
    const anchor = isAnchor ? element : element.closest("a[href]");
    const href = absolute(anchor?.getAttribute("href") ?? element.getAttribute("formaction"), base);
    // A link whose destination is unusable (a script URL, for example) is not a call to action.
    if (isAnchor && !href) continue;
    const key = `${text}\u0000${href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(href ? { text, href } : { text });
    if (result.length >= MAX_CTAS) break;
  }
  return result;
}

function periodOf(text: string): string | undefined {
  const match = PERIOD.exec(text);
  if (!match) return undefined;
  return (match[1] ?? match[2] ?? "").toLowerCase().replace(/^mo$/u, "month").replace(/^yr$/u, "year").replace(/[- ]/gu, "-");
}

function pricingOf(doc: Document): PageFacts["pricing"] {
  const body = doc.body;
  if (!body) return undefined;
  const picked: Element[] = [];
  for (const element of Array.from(body.querySelectorAll(PRICE_TAGS))) {
    const text = norm(element.textContent);
    if (!text || text.length > MAX_TEXT) continue;
    const amounts = findAmounts(text);
    if (amounts.length === 0) continue;
    // Prefer the deepest element that still holds all of the amounts.
    const deeper = Array.from(element.querySelectorAll(PRICE_TAGS)).some((child) => {
      const childAmounts = findAmounts(norm(child.textContent));
      return childAmounts.length >= amounts.length;
    });
    if (!deeper) picked.push(element);
  }

  const signals: PriceSignal[] = [];
  const seen = new Set<string>();
  for (const element of picked) {
    const text = norm(element.textContent);
    // A bare amount is labelled by the nearest wrapper that adds words.
    let labelSource = text;
    let wrapper: Element | null = element;
    for (let depth = 0; depth < 3 && wrapper && labelSource.replace(/[^\p{L}]/gu, "").length < 3; depth += 1) {
      wrapper = wrapper.parentElement;
      const wrapperText = norm(wrapper?.textContent);
      if (wrapperText.length > MAX_TEXT) break;
      if (wrapperText.length > labelSource.length && findAmounts(wrapperText).length === findAmounts(text).length) {
        labelSource = wrapperText;
      }
    }
    const plan = planOf(element, picked);
    const period = periodOf(labelSource);
    for (const amount of findAmounts(text)) {
      const key = `${amount}\u0000${plan ?? ""}\u0000${labelSource}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const signal: PriceSignal = { amount, label: clip(labelSource, 120) };
      if (plan) signal.plan = plan;
      if (period) signal.period = period;
      signals.push(signal);
      if (signals.length >= MAX_PRICES) break;
    }
    if (signals.length >= MAX_PRICES) break;
  }

  const bodyText = norm(body.textContent).toLowerCase();
  const phrases = PRICE_PHRASES.filter((phrase) => bodyText.includes(phrase));
  if (signals.length === 0 && phrases.length === 0) return undefined;
  return { amounts: signals, ...(phrases.length > 0 ? { phrases } : {}) };
}

/** Name of the plan card or section holding a price, when that is unambiguous. */
function planOf(price: Element, allPrices: Element[]): string | undefined {
  let ancestor = price.parentElement;
  for (let depth = 0; depth < 5 && ancestor && ancestor.tagName !== "BODY"; depth += 1) {
    const labelled = ancestor.getAttribute("data-plan") ?? ancestor.getAttribute("data-tier");
    if (labelled && norm(labelled)) return clip(norm(labelled), 40);
    const inside = allPrices.filter((other) => ancestor?.contains(other)).length;
    if (inside > 2) return undefined;
    for (const heading of Array.from(ancestor.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
      if (heading.contains(price) || price.contains(heading)) continue;
      const text = norm(heading.textContent);
      if (text && text.length <= 40 && findAmounts(text).length === 0) return text;
    }
    ancestor = ancestor.parentElement;
  }
  return undefined;
}

function dateOf(container: Element): string | undefined {
  const time = container.querySelector("time");
  const stamp = time?.getAttribute("datetime")?.trim() || norm(time?.textContent);
  if (stamp) return clip(stamp, 40);
  const match = DATE_TEXT.exec(norm(container.textContent));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function itemsOf(doc: Document, base: string): { title: string; href: string; date?: string }[] {
  const containers = new Set<Element>();
  for (const article of Array.from(doc.querySelectorAll("article"))) containers.add(article);
  for (const time of Array.from(doc.querySelectorAll("time"))) {
    const container = time.closest("article, li") ?? time.closest("div, section");
    if (container && norm(container.textContent).length <= 800) containers.add(container);
  }
  const items: { title: string; href: string; date?: string }[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    const headingLink = container.querySelector("h1 a[href], h2 a[href], h3 a[href], h4 a[href]");
    const link = headingLink ?? container.querySelector("a[href]");
    const href = absolute(link?.getAttribute("href") ?? null, base);
    const heading = container.querySelector("h1, h2, h3, h4");
    const title = norm(heading?.textContent) || norm(link?.textContent);
    if (!href || !title || title.length > 200 || seen.has(href)) continue;
    seen.add(href);
    const date = dateOf(container);
    items.push(date ? { title, href, date } : { title, href });
    if (items.length >= MAX_ITEMS) break;
  }
  // A single entry is an article page, not an index.
  return items.length >= 2 ? items : [];
}

/** Read bounded structured facts from raw HTML. Never throws; failures become warnings. */
export function extractFacts(html: string, url: string, options: { watch?: WatchKind } = {}): PageFacts {
  const facts: PageFacts = {};
  const warnings: string[] = [];
  let doc: Document;
  try {
    doc = new JSDOM(html, { url }).window.document;
  } catch {
    return { warnings: ["The HTML could not be parsed."] };
  }
  for (const element of Array.from(doc.querySelectorAll("script, style, noscript, template"))) {
    // JSON-LD is read before removal below; keep it by only dropping non-JSON-LD scripts later.
    if (element.tagName === "SCRIPT" && element.getAttribute("type") === "application/ld+json") continue;
    element.remove();
  }

  const guarded = <T>(name: string, read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      warnings.push(`${name} could not be read.`);
      return undefined;
    }
  };

  const title = norm(doc.querySelector("title")?.textContent);
  if (title) facts.title = clip(title, 200);
  const description = norm(doc.querySelector('meta[name="description" i]')?.getAttribute("content"));
  if (description) facts.metaDescription = clip(description, 400);
  const canonical = absolute(doc.querySelector('link[rel~="canonical" i]')?.getAttribute("href") ?? null, url);
  if (canonical) facts.canonicalUrl = canonical;

  const outline = guarded("Outline", () => outlineOf(doc));
  if (outline && outline.length > 0) facts.outline = outline;
  const ctas = guarded("Calls to action", () => ctasOf(doc, url));
  if (ctas && ctas.length > 0) facts.callsToAction = ctas;
  const pricing = guarded("Pricing signals", () => pricingOf(doc));
  if (pricing) facts.pricing = pricing;
  const hero = guarded("Hero", () => heroOf(doc, ctas ?? []));
  if (hero) facts.hero = hero;
  const watch = options.watch ?? "general";
  if (watch === "careers") {
    const roles = guarded("Roles", () => rolesOf(doc, url));
    if (roles && roles.length > 0) facts.roles = roles;
  }
  if (watch === "integrations") {
    const names = guarded("Integrations", () => integrationNamesOf(doc));
    if (names && names.length > 0) facts.integrations = names;
  }
  if (watch === "security") {
    const certifications = guarded("Certifications", () => certificationsOf(doc));
    if (certifications && certifications.length > 0) facts.certifications = certifications;
  }
  if (watch === "changelog") {
    const releases = guarded("Releases", () => releasesOf(doc));
    if (releases && releases.length > 0) facts.releases = releases;
  }
  const pricingTable = guarded("Pricing table", () => extractPricingTable(doc));
  if (pricingTable) facts.pricingTable = pricingTable;
  const types = guarded("Schema types", () => extractSchemaTypes(doc));
  if (types && types.length > 0) facts.schemaTypes = types.slice(0, MAX_SCHEMA_TYPES);
  const products = guarded("Product data", () => extractProducts(doc));
  if (products && products.length > 0) facts.products = products;
  const items = guarded("Index items", () => itemsOf(doc, url));
  if (items && items.length > 0) facts.items = items;

  if (warnings.length > 0) facts.warnings = warnings;
  return facts;
}
