import type { PageFacts } from "../../src/facts.js";

export type ChangeKind = "price" | "plan" | "cta" | "title" | "description" | "canonical" | "heading" | "schema" | "item" | "page";

/** A change in what the page states, as opposed to a change in its text. */
export interface FactChange {
  kind: ChangeKind;
  /** Price, plan, call-to-action and page-removal changes are material. */
  material: boolean;
  description: string;
}

const MATERIAL: ChangeKind[] = ["price", "plan", "cta"];

function change(kind: ChangeKind, description: string): FactChange {
  return { kind, material: MATERIAL.includes(kind), description };
}

function priceMap(facts: PageFacts | undefined): Map<string, { plan: boolean; values: Set<string> }> {
  const map = new Map<string, { plan: boolean; values: Set<string> }>();
  for (const signal of facts?.pricing?.amounts ?? []) {
    const hasPlan = Boolean(signal.plan);
    // Unnamed prices are keyed by their wording with the amount masked, so a changed amount still lines up.
    const key = signal.plan ?? signal.label.replace(/(?:[€$£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:EUR|USD|GBP)|(?:EUR|USD|GBP)\s?\d[\d,.]*)/giu, "<amount>");
    const entry = map.get(key) ?? { plan: hasPlan, values: new Set<string>() };
    entry.values.add(signal.period ? `${signal.amount}/${signal.period}` : signal.amount);
    map.set(key, entry);
  }
  return map;
}

function productPrices(facts: PageFacts | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const product of facts?.products ?? []) {
    const name = product.name ?? product.sku ?? "product";
    for (const offer of product.offers) {
      const price = offer.price ?? offer.lowPrice;
      if (price === undefined) continue;
      const set = map.get(name) ?? new Set<string>();
      set.add(`${offer.priceCurrency ?? ""} ${price}`.trim());
      map.set(name, set);
    }
  }
  return map;
}

const same = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((value) => b.has(value));
const listed = (values: Iterable<string>): string => [...values].join(", ");

/** Compare the facts of two observations of the same page. Deterministic. */
export function diffFacts(before: PageFacts | undefined, after: PageFacts | undefined): FactChange[] {
  const changes: FactChange[] = [];
  if (!before || !after) return changes;

  const oldPrices = priceMap(before);
  const newPrices = priceMap(after);
  for (const [key, entry] of newPrices) {
    const old = oldPrices.get(key);
    const name = entry.plan ? `Plan "${key}"` : `Price "${key}"`;
    if (!old) {
      changes.push(change(entry.plan ? "plan" : "price", `${name} appeared at ${listed(entry.values)}.`));
    } else if (!same(old.values, entry.values)) {
      changes.push(change("price", `${name} changed from ${listed(old.values)} to ${listed(entry.values)}.`));
    }
  }
  for (const [key, entry] of oldPrices) {
    if (!newPrices.has(key)) {
      changes.push(change(entry.plan ? "plan" : "price", `${entry.plan ? `Plan "${key}"` : `Price "${key}"`} (${listed(entry.values)}) is no longer shown.`));
    }
  }

  const oldOffers = productPrices(before);
  const newOffers = productPrices(after);
  for (const [name, values] of newOffers) {
    const old = oldOffers.get(name);
    if (old && !same(old, values)) changes.push(change("price", `Structured price for "${name}" changed from ${listed(old)} to ${listed(values)}.`));
    if (!old) changes.push(change("price", `Structured price for "${name}" appeared at ${listed(values)}.`));
  }
  for (const [name, values] of oldOffers) {
    if (!newOffers.has(name)) changes.push(change("price", `Structured price for "${name}" (${listed(values)}) is no longer declared.`));
  }

  const ctaKey = (cta: { text: string; href?: string }): string => `${cta.text}\u0000${cta.href ?? ""}`;
  const oldCtas = new Map((before.callsToAction ?? []).map((cta) => [ctaKey(cta), cta]));
  const newCtas = new Map((after.callsToAction ?? []).map((cta) => [ctaKey(cta), cta]));
  const retargeted = new Set<string>();
  for (const [key, cta] of newCtas) {
    if (oldCtas.has(key)) continue;
    const sameText = [...oldCtas.values()].find((old) => old.text === cta.text && !newCtas.has(ctaKey(old)));
    if (sameText) {
      retargeted.add(ctaKey(sameText));
      changes.push(change("cta", `Button "${cta.text}" now links to ${cta.href ?? "nothing"} (was ${sameText.href ?? "nothing"}).`));
    } else {
      changes.push(change("cta", `Button "${cta.text}"${cta.href ? ` linking to ${cta.href}` : ""} was added.`));
    }
  }
  for (const [key, cta] of oldCtas) {
    if (!newCtas.has(key) && !retargeted.has(key)) {
      changes.push(change("cta", `Button "${cta.text}"${cta.href ? ` linking to ${cta.href}` : ""} was removed.`));
    }
  }

  if (before.title !== after.title) changes.push(change("title", `Title changed from "${before.title ?? "none"}" to "${after.title ?? "none"}".`));
  if (before.metaDescription !== after.metaDescription) changes.push(change("description", "Meta description changed."));
  if (before.canonicalUrl !== after.canonicalUrl) changes.push(change("canonical", `Canonical changed from ${before.canonicalUrl ?? "none"} to ${after.canonicalUrl ?? "none"}.`));

  const headings = (facts: PageFacts): Set<string> => new Set((facts.outline ?? []).map((heading) => `H${heading.level} ${heading.text}`));
  const oldHeadings = headings(before);
  const newHeadings = headings(after);
  for (const heading of newHeadings) if (!oldHeadings.has(heading)) changes.push(change("heading", `Heading added: ${heading}.`));
  for (const heading of oldHeadings) if (!newHeadings.has(heading)) changes.push(change("heading", `Heading removed: ${heading}.`));

  const oldTypes = new Set(before.schemaTypes ?? []);
  const newTypes = new Set(after.schemaTypes ?? []);
  for (const type of newTypes) if (!oldTypes.has(type)) changes.push(change("schema", `Structured data type added: ${type}.`));
  for (const type of oldTypes) if (!newTypes.has(type)) changes.push(change("schema", `Structured data type removed: ${type}.`));

  const oldItems = new Set((before.items ?? []).map((item) => item.href));
  for (const item of after.items ?? []) {
    if (!oldItems.has(item.href)) changes.push(change("item", `New entry: "${item.title}"${item.date ? ` (${item.date})` : ""}.`));
  }
  return changes;
}

/** The part of the facts that decides whether a page counts as changed. */
export function factsForComparison(facts: PageFacts | undefined): unknown {
  if (!facts) return null;
  return {
    title: facts.title ?? null,
    description: facts.metaDescription ?? null,
    canonical: facts.canonicalUrl ?? null,
    outline: facts.outline ?? [],
    ctas: facts.callsToAction ?? [],
    prices: [...priceMap(facts)].map(([key, entry]) => [key, [...entry.values].sort()]).sort(),
    offers: [...productPrices(facts)].map(([key, values]) => [key, [...values].sort()]).sort(),
    types: facts.schemaTypes ?? [],
    items: (facts.items ?? []).map((item) => item.href),
  };
}
