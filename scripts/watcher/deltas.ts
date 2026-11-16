import { diffPricing, pricingKey } from "../../src/pricing.js";

import type { PageFacts } from "../../src/facts.js";
import type { PriceEventType } from "../../src/pricing.js";

export type ChangeKind =
  | "price" | "plan" | "cta" | "feature" | "promo" | "positioning" | "title" | "description" | "canonical" | "heading" | "schema"
  | "item" | "post" | "role" | "release" | "integration" | "certification" | "page";

/** How much a change matters. High and medium create inbox tasks; low is shown in the note only. */
export type Severity = "high" | "medium" | "low";

/** A change in what the page states, as opposed to a change in its text. */
export interface FactChange {
  kind: ChangeKind;
  severity: Severity;
  /** True for high and medium severity. */
  material: boolean;
  description: string;
  /** Typed event name, such as `price_up`, `plan_renamed`, `new_post` or `integration_added`. */
  type?: string;
  plan?: string;
  old?: string;
  new?: string;
  absoluteChange?: number;
  percentChange?: number;
}

export interface DiffFactsOptions {
  /** Price changes smaller than this many per cent are shown but never material. */
  priceThresholdPct?: number;
}

function change(kind: ChangeKind, severity: Severity, description: string, extra: Partial<FactChange> = {}): FactChange {
  return { kind, severity, material: severity !== "low", description, ...extra };
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
const hasPlans = (facts: PageFacts | undefined): boolean => (facts?.pricingTable?.plans.length ?? 0) > 0;

const PRICE_TYPES: PriceEventType[] = ["price_up", "price_down", "price_changed", "period_changed", "unit_changed", "currency_changed", "rate_changed"];

/** Plan-level changes from the structured pricing table. */
function tableChanges(before: PageFacts, after: PageFacts, options: DiffFactsOptions): FactChange[] {
  const result: FactChange[] = [];
  const { events } = diffPricing(before.pricingTable ?? { plans: [], promos: [] }, after.pricingTable ?? { plans: [], promos: [] }, options.priceThresholdPct !== undefined ? { priceThresholdPct: options.priceThresholdPct } : {});
  for (const event of events) {
    const extra: Partial<FactChange> = { type: event.type };
    if (event.plan) extra.plan = event.plan;
    if (event.old !== undefined) extra.old = event.old;
    if (event.new !== undefined) extra.new = event.new;
    if (event.absoluteChange !== undefined) extra.absoluteChange = event.absoluteChange;
    if (event.percentChange !== undefined) extra.percentChange = event.percentChange;
    if (PRICE_TYPES.includes(event.type)) {
      const small = event.belowThreshold === true;
      result.push(change("price", small ? "low" : "high", small ? `${event.description} This is below the materiality threshold.` : event.description, extra));
    } else if (event.type === "plan_added" || event.type === "plan_removed" || event.type === "free_tier_added" || event.type === "free_tier_removed") {
      result.push(change("plan", "high", event.description, extra));
    } else if (event.type === "plan_renamed" || event.type === "trial_added" || event.type === "trial_removed") {
      result.push(change("plan", "medium", event.description, extra));
    } else if (event.type === "feature_added" || event.type === "feature_removed") {
      result.push(change("feature", "medium", event.description, extra));
    } else {
      result.push(change("promo", "medium", event.description, extra));
    }
  }
  return result;
}

/** Older, signal-level price comparison, used when a page has no plan table. */
function signalChanges(before: PageFacts, after: PageFacts): FactChange[] {
  const changes: FactChange[] = [];
  const oldPrices = priceMap(before);
  const newPrices = priceMap(after);
  for (const [key, entry] of newPrices) {
    const old = oldPrices.get(key);
    const name = entry.plan ? `Plan "${key}"` : `Price "${key}"`;
    if (!old) {
      changes.push(change(entry.plan ? "plan" : "price", "high", `${name} appeared at ${listed(entry.values)}.`));
    } else if (!same(old.values, entry.values)) {
      changes.push(change("price", "high", `${name} changed from ${listed(old.values)} to ${listed(entry.values)}.`));
    }
  }
  for (const [key, entry] of oldPrices) {
    if (!newPrices.has(key)) {
      changes.push(change(entry.plan ? "plan" : "price", "high", `${entry.plan ? `Plan "${key}"` : `Price "${key}"`} (${listed(entry.values)}) is no longer shown.`));
    }
  }
  return changes;
}

function ctaChanges(before: PageFacts, after: PageFacts): FactChange[] {
  const changes: FactChange[] = [];
  const ctaKey = (cta: { text: string; href?: string }): string => `${cta.text}\u0000${cta.href ?? ""}`;
  const oldCtas = new Map((before.callsToAction ?? []).map((cta) => [ctaKey(cta), cta]));
  const newCtas = new Map((after.callsToAction ?? []).map((cta) => [ctaKey(cta), cta]));
  const retargeted = new Set<string>();
  for (const [key, cta] of newCtas) {
    if (oldCtas.has(key)) continue;
    const sameText = [...oldCtas.values()].find((old) => old.text === cta.text && !newCtas.has(ctaKey(old)));
    if (sameText) {
      retargeted.add(ctaKey(sameText));
      changes.push(change("cta", "medium", `Button "${cta.text}" now links to ${cta.href ?? "nothing"} (was ${sameText.href ?? "nothing"}).`, { type: "cta_changed" }));
    } else {
      changes.push(change("cta", "medium", `Button "${cta.text}"${cta.href ? ` linking to ${cta.href}` : ""} was added.`, { type: "cta_added" }));
    }
  }
  for (const [key, cta] of oldCtas) {
    if (!newCtas.has(key) && !retargeted.has(key)) {
      changes.push(change("cta", "medium", `Button "${cta.text}"${cta.href ? ` linking to ${cta.href}` : ""} was removed.`, { type: "cta_removed" }));
    }
  }
  return changes;
}

/** Headline, meta description and opening paragraph. Button changes are reported as button events instead. */
function positioningChanges(before: PageFacts, after: PageFacts): FactChange[] {
  const changes: FactChange[] = [];
  const oldHero = before.hero;
  const newHero = after.hero;
  const check = (label: string, a: string | undefined, b: string | undefined): void => {
    if ((a ?? "") !== (b ?? "")) {
      changes.push(change("positioning", "medium", `${label} changed from "${a ?? "none"}" to "${b ?? "none"}".`, { type: "positioning_changed", ...(a !== undefined ? { old: a } : {}), ...(b !== undefined ? { new: b } : {}) }));
    }
  };
  check("Headline (H1)", oldHero?.h1, newHero?.h1);
  check("Meta description", before.metaDescription ?? oldHero?.description, after.metaDescription ?? newHero?.description);
  check("Opening paragraph", oldHero?.lead, newHero?.lead);
  return changes;
}

function listChanges<T>(
  before: T[] | undefined,
  after: T[] | undefined,
  key: (item: T) => string,
  added: (item: T) => FactChange,
  removed?: (item: T) => FactChange,
): FactChange[] {
  const result: FactChange[] = [];
  const oldKeys = new Set((before ?? []).map(key));
  const newKeys = new Set((after ?? []).map(key));
  for (const item of after ?? []) if (!oldKeys.has(key(item))) result.push(added(item));
  if (removed) for (const item of before ?? []) if (!newKeys.has(key(item))) result.push(removed(item));
  return result;
}

function rolesByDepartment(roles: { department?: string }[]): string {
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role.department ?? "Unspecified", (counts.get(role.department ?? "Unspecified") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `${name} ${count}`).join(", ");
}

/** Compare the facts of two observations of the same page. Deterministic. */
export function diffFacts(before: PageFacts | undefined, after: PageFacts | undefined, options: DiffFactsOptions = {}): FactChange[] {
  const changes: FactChange[] = [];
  if (!before || !after) return changes;

  changes.push(...hasPlans(before) && hasPlans(after) ? tableChanges(before, after, options) : signalChanges(before, after));
  if (!hasPlans(before) && !hasPlans(after) && (before.pricingTable?.promos.length ?? 0) + (after.pricingTable?.promos.length ?? 0) > 0) {
    changes.push(...tableChanges(before, after, options).filter((entry) => entry.kind === "promo"));
  }

  const oldOffers = productPrices(before);
  const newOffers = productPrices(after);
  for (const [name, values] of newOffers) {
    const old = oldOffers.get(name);
    if (old && !same(old, values)) changes.push(change("price", "high", `Structured price for "${name}" changed from ${listed(old)} to ${listed(values)}.`, { type: "price_changed" }));
    if (!old) changes.push(change("price", "high", `Structured price for "${name}" appeared at ${listed(values)}.`, { type: "price_changed" }));
  }
  for (const [name, values] of oldOffers) {
    if (!newOffers.has(name)) changes.push(change("price", "high", `Structured price for "${name}" (${listed(values)}) is no longer declared.`, { type: "price_changed" }));
  }

  // A button named after a renamed plan ("Choose Growth") is explained by the rename, so it is not reported twice.
  const renamed = changes.filter((entry) => entry.type === "plan_renamed").flatMap((entry) => [entry.old, entry.new]).filter((name): name is string => Boolean(name)).map((name) => name.toLowerCase());
  changes.push(...ctaChanges(before, after).filter((entry) => !renamed.some((name) => entry.description.toLowerCase().includes(name))));
  changes.push(...positioningChanges(before, after));

  if (before.title !== after.title) changes.push(change("title", "low", `Title changed from "${before.title ?? "none"}" to "${after.title ?? "none"}".`));
  if (before.canonicalUrl !== after.canonicalUrl) changes.push(change("canonical", "low", `Canonical changed from ${before.canonicalUrl ?? "none"} to ${after.canonicalUrl ?? "none"}.`));

  const headings = (facts: PageFacts): Set<string> => new Set((facts.outline ?? []).map((heading) => `H${heading.level} ${heading.text}`));
  const oldHeadings = headings(before);
  const newHeadings = headings(after);
  for (const heading of newHeadings) if (!oldHeadings.has(heading)) changes.push(change("heading", "low", `Heading added: ${heading}.`));
  for (const heading of oldHeadings) if (!newHeadings.has(heading)) changes.push(change("heading", "low", `Heading removed: ${heading}.`));

  const oldTypes = new Set(before.schemaTypes ?? []);
  const newTypes = new Set(after.schemaTypes ?? []);
  for (const type of newTypes) if (!oldTypes.has(type)) changes.push(change("schema", "low", `Structured data type added: ${type}.`));
  for (const type of oldTypes) if (!newTypes.has(type)) changes.push(change("schema", "low", `Structured data type removed: ${type}.`));

  changes.push(...listChanges(
    before.items, after.items, (item) => item.href,
    (item) => change("post", "low", `New entry: "${item.title}"${item.date ? ` (${item.date})` : ""}.`, { type: "new_post", new: item.href }),
  ));

  changes.push(...listChanges(
    before.releases, after.releases, (release) => release.title,
    (release) => change("release", "medium", `New release entry: "${release.title}"${release.date ? ` (${release.date})` : ""}.`, { type: "new_release" }),
  ));

  if (before.roles || after.roles) {
    const newRoles = listChanges(
      before.roles, after.roles, (role) => `${role.title}\u0000${role.href ?? ""}`,
      (role) => change("role", "low", `New role: "${role.title}"${role.department ? ` in ${role.department}` : ""}${role.location ? ` (${role.location})` : ""}.`, { type: "new_role", new: role.title }),
      (role) => change("role", "low", `Role closed or removed: "${role.title}"${role.department ? ` in ${role.department}` : ""}.`, { type: "role_closed", old: role.title }),
    );
    changes.push(...newRoles);
    const opened = newRoles.filter((entry) => entry.type === "new_role").length;
    if (opened >= 3) {
      const oldKeys = new Set((before.roles ?? []).map((role) => `${role.title}\u0000${role.href ?? ""}`));
      const fresh = (after.roles ?? []).filter((role) => !oldKeys.has(`${role.title}\u0000${role.href ?? ""}`));
      changes.push(change("role", "medium", `Hiring picked up: ${opened} new roles (${rolesByDepartment(fresh)}). ${(after.roles ?? []).length} roles are open in total.`, { type: "hiring_surge" }));
    }
  }

  changes.push(...listChanges(
    before.integrations, after.integrations, (name) => name.toLowerCase(),
    (name) => change("integration", "medium", `Integration or partner added: ${name}.`, { type: "integration_added", new: name }),
    (name) => change("integration", "medium", `Integration or partner removed: ${name}.`, { type: "integration_removed", old: name }),
  ));
  changes.push(...listChanges(
    before.certifications, after.certifications, (name) => name,
    (name) => change("certification", "medium", `Security or trust item now mentioned: ${name}.`, { type: "certification_added", new: name }),
    (name) => change("certification", "medium", `Security or trust item no longer mentioned: ${name}.`, { type: "certification_removed", old: name }),
  ));
  return changes;
}

/** The part of the facts that decides whether a page counts as changed. */
export function factsForComparison(facts: PageFacts | undefined): unknown {
  if (!facts) return null;
  return {
    title: facts.title ?? null,
    description: facts.metaDescription ?? null,
    canonical: facts.canonicalUrl ?? null,
    hero: facts.hero ?? null,
    outline: facts.outline ?? [],
    ctas: facts.callsToAction ?? [],
    // The plan table is the more reliable price record; the loose signals only matter when there is no table.
    pricing: hasPlans(facts) || (facts.pricingTable?.promos.length ?? 0) > 0 ? pricingKey(facts.pricingTable) : [...priceMap(facts)].map(([key, entry]) => [key, [...entry.values].sort()]).sort(),
    offers: [...productPrices(facts)].map(([key, values]) => [key, [...values].sort()]).sort(),
    types: facts.schemaTypes ?? [],
    items: (facts.items ?? []).map((item) => item.href),
    roles: (facts.roles ?? []).map((role) => [role.title, role.href ?? null]),
    integrations: facts.integrations ?? [],
    certifications: facts.certifications ?? [],
    releases: (facts.releases ?? []).map((release) => release.title),
  };
}
