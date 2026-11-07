/**
 * Plan-level price model.
 *
 * Reads plan cards from a page into a structured table (name, price, currency,
 * billing period, unit, free and trial flags, listed features) and compares two
 * tables so that a rename is reported as a rename, not as a removal plus an
 * addition. Everything is observed from the page text: nothing is inferred
 * beyond reading the symbols and words that are there, and currencies are never
 * converted.
 */

export type BillingPeriod = "month" | "year" | "quarter" | "week" | "day" | "one-off";

export interface PlanPrice {
  /** Heading of the plan card, as written. */
  name: string;
  /** Order of the plan on the page, starting at 0. */
  position: number;
  /** Stated amount; the lower end for a range. Omitted when the card states no price. */
  amount?: number;
  /** Upper end when the price is a range. */
  maxAmount?: number;
  /** "from" when the page writes "from" or "starting at" before the price. */
  qualifier?: "from";
  /** EUR, GBP or USD when the page makes that explicit, otherwise the symbol as written. */
  currency?: string;
  period?: BillingPeriod;
  /** What the price is per, such as `user`, `seat` or `1k credits`. */
  unit?: string;
  /** Equivalent monthly amount for month, quarter and year periods, in the same currency. */
  perMonth?: number;
  free?: boolean;
  trial?: boolean;
  /** The same plan priced in another currency on the same card. */
  alternates?: { amount: number; currency: string }[];
  features: string[];
  /** Further prices on the card, such as a rate per 1,000 credits or top-up packs. */
  rates?: { text: string; amount: number; currency: string }[];
}

export interface PricingTable {
  plans: PlanPrice[];
  /** Discount and promotion banners, as written. */
  promos: string[];
}

const MAX_PLANS = 30;
const MAX_FEATURES = 12;
const MAX_RATES = 8;
const MAX_PROMOS = 5;
const CARD_TEXT_LIMIT = 900;

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const MONEY = new RegExp(
  String.raw`(?:(US\$|€|£|\$)\s?(${NUMBER})(?:\s?([kK])\b)?|\b(EUR|USD|GBP)\s?(${NUMBER})(?:\s?([kK])\b)?|\b(${NUMBER})\s?(EUR|USD|GBP|€)(?![\p{L}]))`,
  "gu",
);
/** Magnitude words that mark a figure as a fine, a turnover or a market size rather than a price. */
const MAGNITUDE = /^\s?(?:m\b|bn\b|billion\b|million\b|mn\b)/iu;
const RANGE_GAP = /^\s*(?:[-–—]|to)\s*$/iu;
const ALTERNATE_GAP = /^\s*(?:\/|\bor\b|\|)\s*$/iu;
const PERIOD_AFTER = /(?:\/|\bper\b|\ba\b|\beach\b|\bevery\b|\bbilled\b)?\s*\b(month|mo|monthly|year|yr|yearly|annually|annum|quarter|quarterly|week|weekly|day|daily)\b/iu;
const UNIT_AFTER = /(?:\/|\bper\b)\s*((?:\d[\d,]*\s?[kKmM]?\s+)?(?:user|seat|member|agent|project|site|domain|request|call|page|credit|gb|token|node|device|employee|location)s?)\b/iu;
const ONE_OFF = /\bone[- ]?(?:off|time)\b|\bsingle payment\b/iu;
const TRIAL = /\btrial\b|\bfree test\b|\btry (?:it )?(?:for )?free\b|\b\d+[- ]day free\b/iu;
const FROM = /\b(?:from|starting at|starts at|as low as)\s*$/iu;
const FINE_WORDS = /\b(?:fines?|penalt(?:y|ies)|turnover|sanctions?|revenue)\b/iu;
const PROMO = /\d{1,3}\s?%\s*(?:off|discount)|\bsave\s+(?:up to\s+)?\d{1,3}\s?%|\bsave\s+(?:up to\s+)?(?:US\$|€|£|\$)\s?\d|\bdiscount\b|\bpromo(?:tion|tional)?\b|\bcoupon\b|\blimited[- ]time\b|\bblack friday\b|\bcyber monday\b|\bearly[- ]bird\b|\bspecial offer\b|\buse code\b|\blaunch (?:offer|price|pricing)\b/iu;
/** Real headings, plus the styled elements that sites use as plan names. */
const HEADING = "h2, h3, h4, h5, [role='heading'], .h2, .h3, .h4, .h5, [class*='plan-name' i], [class*='tier-name' i], [class*='plan-title' i], [class*='package-name' i]";
const SKIPPED_HEADING = /^(?:pricing|plans?|compare|frequently asked questions|faq|questions?)\b/iu;
const FREE_OR_CUSTOM = /^(?:free|custom|enterprise|contact)\b/iu;

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "BR", "TR", "TD", "TH", "UL", "OL", "ARTICLE"]);

interface MoneyToken {
  start: number;
  end: number;
  amount: number;
  maxAmount?: number;
  currency: string;
  from: boolean;
  alternates: { amount: number; currency: string }[];
}

function norm(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/gu, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toNumber(raw: string, kilo: string | undefined): number {
  const value = Number(raw.replace(/,/gu, ""));
  return kilo ? value * 1000 : value;
}

function currencyOf(symbol: string): string {
  if (symbol === "€" || symbol === "EUR") return "EUR";
  if (symbol === "£" || symbol === "GBP") return "GBP";
  if (symbol === "US$" || symbol === "USD") return "USD";
  return symbol;
}

/** Money amounts in order, with ranges and same-card alternate currencies merged. Ignores fines and other large figures. */
export function parseMoney(text: string): MoneyToken[] {
  const raw: { start: number; end: number; amount: number; currency: string }[] = [];
  for (const match of text.matchAll(MONEY)) {
    const end = (match.index ?? 0) + match[0].length;
    if (MAGNITUDE.test(text.slice(end, end + 12))) continue;
    // Digit tickers and counters are not prices.
    if ((match[2] ?? match[5] ?? match[7] ?? "").replace(/[^0-9]/gu, "").length > 9) continue;
    const symbol = match[1] ?? match[4] ?? match[8] ?? "";
    const number = match[2] ?? match[5] ?? match[7] ?? "";
    const kilo = match[3] ?? match[6];
    raw.push({ start: match.index ?? 0, end, amount: toNumber(number, kilo), currency: currencyOf(symbol) });
  }
  const tokens: MoneyToken[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    if (!current) continue;
    const token: MoneyToken = {
      start: current.start, end: current.end, amount: current.amount, currency: current.currency,
      from: FROM.test(text.slice(Math.max(0, current.start - 16), current.start)), alternates: [],
    };
    for (;;) {
      const next = raw[index + 1];
      if (!next) break;
      const gap = text.slice(token.end, next.start);
      if (RANGE_GAP.test(gap) && next.currency === token.currency && next.amount >= token.amount) {
        token.maxAmount = next.amount;
      } else if (ALTERNATE_GAP.test(gap) && next.currency !== token.currency) {
        token.alternates.push({ amount: next.amount, currency: next.currency });
      } else {
        break;
      }
      token.end = next.end;
      index += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

function periodOf(after: string): BillingPeriod | undefined {
  const match = PERIOD_AFTER.exec(after);
  const word = match?.[1]?.toLowerCase();
  if (!word) return undefined;
  if (word.startsWith("mo")) return "month";
  if (word === "yr" || word.startsWith("year") || word === "annually" || word === "annum") return "year";
  if (word.startsWith("quarter")) return "quarter";
  if (word.startsWith("week")) return "week";
  if (word.startsWith("day") || word === "daily") return "day";
  return undefined;
}

export function perMonth(amount: number, period: BillingPeriod | undefined): number | undefined {
  if (period === "month") return amount;
  if (period === "year") return Math.round((amount / 12) * 100) / 100;
  if (period === "quarter") return Math.round((amount / 3) * 100) / 100;
  if (period === "week") return Math.round(((amount * 52) / 12) * 100) / 100;
  return undefined;
}

function textWithBreaks(root: Element, skip: string): string {
  const clone = root.cloneNode(true) as Element;
  for (const element of Array.from(clone.querySelectorAll(skip))) element.remove();
  for (const element of Array.from(clone.querySelectorAll("*"))) {
    if (BLOCK_TAGS.has(element.tagName)) element.append(" ");
  }
  return norm(clone.textContent);
}

function headingsIn(element: Element): number {
  return element.querySelectorAll(HEADING).length;
}

/** The elements that make up the card for a heading: its wrapper, or the siblings that follow it. */
function cardElements(heading: Element, body: Element): Element[] {
  const parent = heading.parentElement;
  if (!parent || parent === body) return [];
  if (headingsIn(parent) === 1) {
    let node: Element = parent;
    for (let depth = 0; depth < 3; depth += 1) {
      const up = node.parentElement;
      if (!up || up === body || headingsIn(up) !== 1 || norm(up.textContent).length > CARD_TEXT_LIMIT) break;
      node = up;
    }
    if (norm(node.textContent).length <= CARD_TEXT_LIMIT) return [node];
  }
  const siblings: Element[] = [];
  for (let next = heading.nextElementSibling; next; next = next.nextElementSibling) {
    if (/^H[1-5]$/u.test(next.tagName) || next.matches(HEADING) || next.querySelector(`h1, ${HEADING}`)) break;
    siblings.push(next);
  }
  return siblings;
}

function planFromCard(name: string, position: number, elements: Element[], pageUsd: boolean): PlanPrice | undefined {
  const holder = elements[0]?.ownerDocument.createElement("div");
  if (!holder) return undefined;
  for (const element of elements) holder.append(element.cloneNode(true));
  for (const candidate of Array.from(holder.querySelectorAll(`h1, h6, ${HEADING}`))) {
    if (norm(candidate.textContent) === name) {
      candidate.remove();
      break;
    }
  }

  const listItems = Array.from(holder.querySelectorAll("li")).filter((item) => item.parentElement !== holder && !item.closest("table")).map((item) => norm(item.textContent));
  // Money that is not in a list or a table belongs to the plan itself.
  const own = textWithBreaks(holder, "table, ul, ol, script, style");
  if (FINE_WORDS.test(own) && parseMoney(own).length > 0 && !/\b(?:month|year|plan|price|pricing|per)\b/iu.test(own)) return undefined;
  const tokens = parseMoney(own);
  const primary = tokens[0];

  const plan: PlanPrice = { name, position, features: [] };
  const fix = (currency: string): string => (currency === "$" && pageUsd ? "USD" : currency);
  if (primary) {
    plan.amount = primary.amount;
    if (primary.maxAmount !== undefined) plan.maxAmount = primary.maxAmount;
    plan.currency = fix(primary.currency);
    if (primary.from) plan.qualifier = "from";
    if (primary.alternates.length > 0) plan.alternates = primary.alternates.map((alternate) => ({ amount: alternate.amount, currency: fix(alternate.currency) }));
    const after = own.slice(primary.end, primary.end + 48);
    const period = periodOf(after) ?? (ONE_OFF.test(own) ? "one-off" : undefined);
    if (period) plan.period = period;
    const unit = UNIT_AFTER.exec(after)?.[1];
    if (unit) plan.unit = unit.toLowerCase().replace(/\s+/gu, " ");
    const monthly = perMonth(primary.amount, plan.period);
    if (monthly !== undefined) plan.perMonth = monthly;
  }
  const hasPositive = (plan.amount ?? 0) > 0;
  if (plan.amount === 0 || (/^free\b/iu.test(name) && !hasPositive)) plan.free = true;
  if (TRIAL.test(`${name} ${own}`)) plan.trial = true;

  const rates: NonNullable<PlanPrice["rates"]> = [];
  const features: string[] = [];
  for (const text of listItems) {
    if (!text || text.length > 120) continue;
    const money = parseMoney(text)[0];
    if (money) {
      if (rates.length < MAX_RATES) rates.push({ text: clip(text, 80), amount: money.amount, currency: fix(money.currency) });
    } else if (features.length < MAX_FEATURES && !features.includes(text)) {
      features.push(text);
    }
  }
  plan.features = features;
  if (rates.length > 0) plan.rates = rates;
  return plan;
}

function promosOf(doc: Document): string[] {
  const found: string[] = [];
  for (const element of Array.from(doc.body.querySelectorAll("p, span, div, a, strong, li, h1, h2, h3, h4, small, b"))) {
    const text = norm(element.textContent);
    if (!text || text.length > 160 || !PROMO.test(text)) continue;
    const deeper = Array.from(element.children).some((child) => PROMO.test(norm(child.textContent)));
    if (deeper) continue;
    const clean = clip(text, 160);
    if (!found.includes(clean)) found.push(clean);
    if (found.length >= MAX_PROMOS) break;
  }
  return found;
}

/** Read the page's plan cards into a table. Returns undefined when the page lists no plans and no promotions. */
export function extractPricingTable(doc: Document): PricingTable | undefined {
  const body = doc.body;
  if (!body) return undefined;
  const pageUsd = /\bUSD\b|US\$/u.test(norm(body.textContent));
  const plans: PlanPrice[] = [];
  const seen = new Set<string>();
  let position = 0;
  for (const heading of Array.from(body.querySelectorAll(HEADING))) {
    const name = norm(heading.textContent);
    if (!name || name.length > 60 || parseMoney(name).length > 0 || SKIPPED_HEADING.test(name)) continue;
    if (heading.closest("table, nav, footer, header")) continue;
    const elements = cardElements(heading, body);
    if (elements.length === 0) continue;
    const plan = planFromCard(name, position, elements, pageUsd);
    if (!plan) continue;
    const pricedOrRated = plan.amount !== undefined || (plan.rates?.length ?? 0) > 0;
    if (!pricedOrRated && !FREE_OR_CUSTOM.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push(plan);
    position += 1;
    if (plans.length >= MAX_PLANS) break;
  }
  // Cards without a price (a "Custom" tier, for example) only count beside plans that do state one.
  const anyPriced = plans.some((plan) => plan.amount !== undefined || (plan.rates?.length ?? 0) > 0);
  const kept = anyPriced ? plans : [];
  const promos = promosOf(doc);
  if (kept.length === 0 && promos.length === 0) return undefined;
  return { plans: kept.map((plan, index) => ({ ...plan, position: index })), promos };
}

// ---------------------------------------------------------------------------
// Comparison

export type PriceEventType =
  | "plan_added" | "plan_removed" | "plan_renamed"
  | "price_up" | "price_down" | "price_changed"
  | "period_changed" | "unit_changed" | "currency_changed"
  | "free_tier_added" | "free_tier_removed" | "trial_added" | "trial_removed"
  | "feature_added" | "feature_removed" | "rate_changed"
  | "promo_added" | "promo_removed";

export interface PriceEvent {
  type: PriceEventType;
  plan?: string;
  description: string;
  old?: string;
  new?: string;
  /** Absolute change in the plan's own currency. */
  absoluteChange?: number;
  /** Change in per cent of the old amount, to one decimal place. */
  percentChange?: number;
}

export interface DiffPricingOptions {
  /** Price changes smaller than this many per cent are marked `belowThreshold`. */
  priceThresholdPct?: number;
}

export interface PricingDiff {
  events: (PriceEvent & { belowThreshold?: boolean })[];
}

export function describePrice(plan: PlanPrice): string {
  if (plan.amount === undefined) return plan.free ? "free" : "no price stated";
  const symbol = plan.currency ?? "";
  const money = (value: number): string => `${symbol.length === 1 ? symbol : `${symbol} `}${value.toLocaleString("en-IE", { maximumFractionDigits: 2 })}`.trim();
  const amount = plan.maxAmount !== undefined ? `${money(plan.amount)} to ${money(plan.maxAmount)}` : money(plan.amount);
  const parts = [plan.qualifier ? `from ${amount}` : amount];
  if (plan.unit) parts.push(`per ${plan.unit}`);
  if (plan.period) parts.push(plan.period === "one-off" ? "one-off" : `per ${plan.period}`);
  return parts.join(" ");
}

const normalName = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const left = new Set(a.map(normalName));
  const right = new Set(b.map(normalName));
  const shared = [...left].filter((value) => right.has(value)).length;
  return shared / (left.size + right.size - shared);
}

const samePrice = (a: PlanPrice, b: PlanPrice): boolean =>
  a.amount !== undefined && a.amount === b.amount && a.maxAmount === b.maxAmount && a.currency === b.currency && a.period === b.period && a.unit === b.unit;

/** Pair plans across two runs: same name first, then renames by price, position and features. */
function matchPlans(before: PlanPrice[], after: PlanPrice[]): { pairs: [PlanPrice, PlanPrice][]; removed: PlanPrice[]; added: PlanPrice[] } {
  const pairs: [PlanPrice, PlanPrice][] = [];
  const oldLeft = [...before];
  const newLeft = [...after];
  for (const old of [...oldLeft]) {
    const index = newLeft.findIndex((candidate) => normalName(candidate.name) === normalName(old.name));
    if (index < 0) continue;
    pairs.push([old, newLeft[index] as PlanPrice]);
    newLeft.splice(index, 1);
    oldLeft.splice(oldLeft.indexOf(old), 1);
  }
  // Rename: the same price and billing, or the same slot with mostly the same features.
  const scored: { old: PlanPrice; next: PlanPrice; score: number }[] = [];
  for (const old of oldLeft) {
    for (const next of newLeft) {
      const near = Math.abs(old.position - next.position) <= 1;
      const overlap = jaccard(old.features, next.features);
      let score = 0;
      if (samePrice(old, next)) score += near ? 3 : 2;
      if (old.position === next.position && overlap >= 0.5) score += 3;
      else if (near && overlap >= 0.6) score += 2;
      if (score >= 2) scored.push({ old, next, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.old.position - b.old.position);
  const usedOld = new Set<PlanPrice>();
  const usedNew = new Set<PlanPrice>();
  for (const { old, next } of scored) {
    if (usedOld.has(old) || usedNew.has(next)) continue;
    usedOld.add(old);
    usedNew.add(next);
    pairs.push([old, next]);
  }
  return {
    pairs,
    removed: oldLeft.filter((plan) => !usedOld.has(plan)),
    added: newLeft.filter((plan) => !usedNew.has(plan)),
  };
}

const rounded = (value: number): number => Math.round(value * 10) / 10;

/** Compare two pricing tables. Deterministic; never converts currencies. */
export function diffPricing(before: PricingTable, after: PricingTable, options: DiffPricingOptions = {}): PricingDiff {
  const events: PricingDiff["events"] = [];
  const threshold = options.priceThresholdPct ?? 0;
  const { pairs, removed, added } = matchPlans(before.plans, after.plans);

  for (const plan of removed) {
    events.push({ type: "plan_removed", plan: plan.name, description: `Plan "${plan.name}" (${describePrice(plan)}) is no longer listed.`, old: describePrice(plan) });
  }
  for (const plan of added) {
    events.push({ type: "plan_added", plan: plan.name, description: `Plan "${plan.name}" was added at ${describePrice(plan)}.`, new: describePrice(plan) });
  }
  for (const [old, next] of pairs) {
    const label = next.name;
    if (normalName(old.name) !== normalName(next.name)) {
      events.push({ type: "plan_renamed", plan: next.name, description: `Plan "${old.name}" was renamed "${next.name}".`, old: old.name, new: next.name });
    }
    if (old.currency !== next.currency && old.amount !== undefined && next.amount !== undefined) {
      events.push({ type: "currency_changed", plan: label, description: `Plan "${label}" changed currency from ${old.currency ?? "none"} to ${next.currency ?? "none"} (${describePrice(old)} to ${describePrice(next)}); no conversion is applied.`, old: describePrice(old), new: describePrice(next) });
    } else if (old.amount !== next.amount || old.maxAmount !== next.maxAmount) {
      if (old.amount === undefined || next.amount === undefined) {
        events.push({ type: "price_changed", plan: label, description: `Plan "${label}" price changed from ${describePrice(old)} to ${describePrice(next)}.`, old: describePrice(old), new: describePrice(next) });
      } else {
        const delta = Math.round((next.amount - old.amount) * 100) / 100;
        const percent = old.amount === 0 ? undefined : rounded((delta / old.amount) * 100);
        const up = delta > 0;
        const text = `Plan "${label}" price went ${up ? "up" : "down"} from ${describePrice(old)} to ${describePrice(next)} (${up ? "+" : ""}${delta}${percent !== undefined ? `, ${up ? "+" : ""}${percent}%` : ""}).`;
        const event: PricingDiff["events"][number] = { type: up ? "price_up" : "price_down", plan: label, description: text, old: describePrice(old), new: describePrice(next), absoluteChange: delta };
        if (percent !== undefined) event.percentChange = percent;
        if (percent !== undefined && Math.abs(percent) < threshold) event.belowThreshold = true;
        events.push(event);
      }
    }
    if (old.period !== next.period && old.amount !== undefined && next.amount !== undefined) {
      events.push({ type: "period_changed", plan: label, description: `Plan "${label}" billing period changed from ${old.period ?? "not stated"} to ${next.period ?? "not stated"}.`, old: old.period ?? "not stated", new: next.period ?? "not stated" });
    }
    if (old.unit !== next.unit && old.amount !== undefined && next.amount !== undefined) {
      events.push({ type: "unit_changed", plan: label, description: `Plan "${label}" price basis changed from ${old.unit ? `per ${old.unit}` : "not stated"} to ${next.unit ? `per ${next.unit}` : "not stated"}.`, old: old.unit ?? "not stated", new: next.unit ?? "not stated" });
    }
    if (!old.free && next.free) events.push({ type: "free_tier_added", plan: label, description: `Plan "${label}" is now free.` });
    if (old.free && !next.free) events.push({ type: "free_tier_removed", plan: label, description: `Plan "${label}" is no longer free.` });
    if (!old.trial && next.trial) events.push({ type: "trial_added", plan: label, description: `Plan "${label}" now offers a trial.` });
    if (old.trial && !next.trial) events.push({ type: "trial_removed", plan: label, description: `Plan "${label}" no longer mentions a trial.` });
    const oldFeatures = new Set(old.features.map(normalName));
    const newFeatures = new Set(next.features.map(normalName));
    for (const feature of next.features) if (!oldFeatures.has(normalName(feature))) events.push({ type: "feature_added", plan: label, description: `Plan "${label}" gained: ${feature}.`, new: feature });
    for (const feature of old.features) if (!newFeatures.has(normalName(feature))) events.push({ type: "feature_removed", plan: label, description: `Plan "${label}" lost: ${feature}.`, old: feature });
    const oldRates = (old.rates ?? []).map((rate) => `${rate.currency}${rate.amount}`).sort().join(",");
    const newRates = (next.rates ?? []).map((rate) => `${rate.currency}${rate.amount}`).sort().join(",");
    if (oldRates !== newRates) {
      events.push({ type: "rate_changed", plan: label, description: `Plan "${label}" rates changed from ${(old.rates ?? []).map((rate) => rate.text).join("; ") || "none"} to ${(next.rates ?? []).map((rate) => rate.text).join("; ") || "none"}.`, old: oldRates, new: newRates });
    }
  }
  const oldPromos = new Set(before.promos.map(normalName));
  const newPromos = new Set(after.promos.map(normalName));
  for (const promo of after.promos) if (!oldPromos.has(normalName(promo))) events.push({ type: "promo_added", description: `Promotion added: ${promo}`, new: promo });
  for (const promo of before.promos) if (!newPromos.has(normalName(promo))) events.push({ type: "promo_removed", description: `Promotion removed: ${promo}`, old: promo });
  return { events };
}

/** The part of a table that decides whether pricing changed. Stable across runs. */
export function pricingKey(table: PricingTable | undefined): unknown {
  if (!table) return null;
  return {
    plans: table.plans.map((plan) => [plan.name, plan.amount ?? null, plan.maxAmount ?? null, plan.currency ?? null, plan.period ?? null, plan.unit ?? null, plan.free ?? false, plan.trial ?? false, plan.features, (plan.rates ?? []).map((rate) => [rate.amount, rate.currency])]),
    promos: table.promos,
  };
}
