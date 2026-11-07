import assert from "node:assert/strict";
import test from "node:test";

import { extractFacts } from "../src/facts.js";
import { describePrice, diffPricing, parseMoney, perMonth } from "../src/pricing.js";

import type { PricingTable } from "../src/pricing.js";

const page = (body: string) => `<!doctype html><html><head><title>Pricing</title></head><body><main>${body}</main></body></html>`;

const CARDS = page(`
<h1>Pricing</h1>
<p>All prices are in USD, plus applicable taxes.</p>
<ul>
  <li><h3>Free test</h3><p>No credit card needed</p><p>$0 for 4 weeks</p><ul><li>250 credits / 4 weeks</li><li>1 req/s</li></ul></li>
  <li><h3>Lite</h3><p>For trying things out</p><p>$10<span>per month</span></p><ul><li>4,000 credits</li><li>$2.50 / 1k credits</li></ul></li>
  <li><h3>Team</h3><p>$20 per user per month</p><ul><li>Single sign-on</li><li>Audit log</li></ul></li>
</ul>
<h2>Top-ups</h2><ul><li>10,000 credits $25</li><li>100,000 credits $150</li></ul>
<h2>Compare</h2><table><tr><td>Lite</td><td>$10/mo</td></tr><tr><td>Team</td><td>$20/mo</td></tr><tr><td>Pro</td><td>$30/mo</td></tr><tr><td>Max</td><td>$40/mo</td></tr></table>
<h3>Custom</h3><p>Volume pricing. Contact us.</p>
`);

void test("plan cards become a structured table with period, unit, free and trial flags", () => {
  const table = extractFacts(CARDS, "https://x.test/pricing").pricingTable;
  assert.ok(table);
  const byName = new Map(table.plans.map((plan) => [plan.name, plan]));
  assert.deepEqual([...byName.keys()], ["Free test", "Lite", "Team", "Top-ups", "Custom"]);

  const free = byName.get("Free test");
  assert.equal(free?.amount, 0);
  assert.equal(free?.free, true);
  assert.equal(free?.trial, true);
  assert.equal(free?.currency, "USD", "the page says USD, so a dollar sign is USD");
  assert.deepEqual(free?.features, ["250 credits / 4 weeks", "1 req/s"]);

  const lite = byName.get("Lite");
  assert.equal(lite?.amount, 10);
  assert.equal(lite?.period, "month");
  assert.equal(lite?.perMonth, 10);
  assert.deepEqual(lite?.features, ["4,000 credits"]);
  assert.deepEqual(lite?.rates?.map((rate) => rate.amount), [2.5], "a per-1k rate is a rate, not a feature");

  const team = byName.get("Team");
  assert.equal(team?.unit, "user");
  assert.equal(team?.period, "month");

  assert.equal(byName.get("Top-ups")?.amount, undefined);
  assert.deepEqual(byName.get("Top-ups")?.rates?.map((rate) => rate.amount), [25, 150]);
  assert.equal(byName.get("Custom")?.amount, undefined);
  assert.equal(byName.get("Compare"), undefined, "a comparison table is not a plan");
});

void test("ranges, from-prices, dual currencies, fines and ticker digits are read correctly", () => {
  const [range] = parseMoney("Typical €4,000 – €6,500 for a team");
  assert.equal(range?.amount, 4000);
  assert.equal(range?.maxAmount, 6500);
  const [dual] = parseMoney("From £1,950 / €2,250 fixed");
  assert.equal(dual?.from, true);
  assert.equal(dual?.currency, "GBP");
  assert.deepEqual(dual?.alternates, [{ amount: 2250, currency: "EUR" }]);
  assert.equal(parseMoney("Fines up to €35M / 7% of turnover").length, 0);
  assert.equal(parseMoney("$123,456,789,012,345,678,901,234").length, 0);
  assert.equal(parseMoney("€5K").at(0)?.amount, 5000);
  assert.equal(perMonth(1200, "year"), 100);
  assert.equal(perMonth(90, "quarter"), 30);
  assert.equal(perMonth(10, "one-off"), undefined);

  const table = extractFacts(page(`<section>
    <article><div class="h3">Pilot</div><p>From £4,500 / €5,200</p><p>One production workflow.</p></article>
    <article><div class="h3">Managed</div><p>From £1,500 / €1,750/mo</p><p>Monitoring and governance.</p></article>
  </section>`), "https://x.test/").pricingTable;
  const pilot = table?.plans.find((plan) => plan.name === "Pilot");
  assert.equal(pilot?.qualifier, "from");
  assert.equal(pilot?.currency, "GBP");
  assert.deepEqual(pilot?.alternates, [{ amount: 5200, currency: "EUR" }]);
  assert.equal(table?.plans.find((plan) => plan.name === "Managed")?.period, "month");
});

void test("a page that mentions a fine amount in a card does not produce a plan", () => {
  const table = extractFacts(page(`<h2>Penalties</h2><p>Breaches can attract fines of €35M or 7% of turnover.</p>`), "https://x.test/").pricingTable;
  assert.equal(table, undefined);
});

void test("promotion banners are collected", () => {
  const table = extractFacts(page(`<div class="banner"><strong>Save 20% with annual billing, limited-time offer</strong></div>
    <h3>Basic</h3><p>$5 per month</p>`), "https://x.test/").pricingTable;
  assert.equal(table?.promos.length, 1);
  assert.match(table?.promos[0] ?? "", /Save 20%/u);
});

const table = (...plans: Partial<PricingTable["plans"][number]>[]): PricingTable => ({
  promos: [],
  plans: plans.map((plan, position) => ({ name: "Plan", position, features: [], ...plan })),
});

void test("a price change reports old, new, absolute and percentage change", () => {
  const before = table({ name: "Pro", amount: 100, currency: "EUR", period: "month" });
  const up = diffPricing(before, table({ name: "Pro", amount: 120, currency: "EUR", period: "month" })).events;
  assert.equal(up[0]?.type, "price_up");
  assert.equal(up[0]?.absoluteChange, 20);
  assert.equal(up[0]?.percentChange, 20);
  assert.match(up[0]?.description ?? "", /from EUR 100 per month to EUR 120 per month \(\+20, \+20%\)/u);
  const down = diffPricing(table({ name: "Pro", amount: 120, currency: "EUR", period: "month" }), before).events;
  assert.equal(down[0]?.type, "price_down");
  assert.equal(down[0]?.percentChange, -16.7);
  // A price that returns to an earlier value is still a change.
  assert.equal(diffPricing(table({ name: "Pro", amount: 120, currency: "EUR" }), table({ name: "Pro", amount: 100, currency: "EUR" })).events.length, 1);
});

void test("small price changes are flagged below the threshold, never hidden", () => {
  const events = diffPricing(table({ name: "Pro", amount: 100, currency: "EUR" }), table({ name: "Pro", amount: 101, currency: "EUR" }), { priceThresholdPct: 2 }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.belowThreshold, true);
  const big = diffPricing(table({ name: "Pro", amount: 100, currency: "EUR" }), table({ name: "Pro", amount: 110, currency: "EUR" }), { priceThresholdPct: 2 }).events;
  assert.equal(big[0]?.belowThreshold, undefined);
});

void test("a rename is a rename, not a removal plus an addition", () => {
  const before = table(
    { name: "Starter", amount: 49, currency: "EUR", period: "month", features: ["1 site", "Email support"] },
    { name: "Pro", amount: 99, currency: "EUR", period: "month", features: ["10 sites", "Priority support"] },
  );
  const sameSlot = diffPricing(before, table(
    { name: "Launch", amount: 49, currency: "EUR", period: "month", features: ["1 site", "Email support"] },
    { name: "Pro", amount: 99, currency: "EUR", period: "month", features: ["10 sites", "Priority support"] },
  )).events;
  assert.deepEqual(sameSlot.map((event) => event.type), ["plan_renamed"]);
  assert.match(sameSlot[0]?.description ?? "", /"Starter" was renamed "Launch"/u);

  // Renamed and repriced in the same slot: matched by position and features.
  const repriced = diffPricing(before, table(
    { name: "Launch", amount: 59, currency: "EUR", period: "month", features: ["1 site", "Email support"] },
    { name: "Pro", amount: 99, currency: "EUR", period: "month", features: ["10 sites", "Priority support"] },
  )).events.map((event) => event.type);
  assert.deepEqual(repriced.sort(), ["plan_renamed", "price_up"]);

  // Reordered cards with unchanged names are not renames.
  assert.equal(diffPricing(before, table(before.plans[1] ?? {}, before.plans[0] ?? {})).events.length, 0);
});

void test("plans added or removed, with period, unit, free, trial, feature, rate and promo changes", () => {
  const before: PricingTable = {
    promos: ["Save 10% on annual plans"],
    plans: [
      { name: "Free", position: 0, amount: 0, currency: "USD", free: true, features: ["1 user"] },
      { name: "Pro", position: 1, amount: 10, currency: "USD", period: "month", unit: "user", trial: true, features: ["SSO", "Audit log"], rates: [{ text: "$2 / 1k", amount: 2, currency: "USD" }] },
      { name: "Legacy", position: 2, amount: 500, currency: "USD", period: "month", features: [] },
    ],
  };
  const after: PricingTable = {
    promos: ["Black Friday: 30% off"],
    plans: [
      { name: "Free", position: 0, amount: 5, currency: "USD", period: "month", features: ["1 user"] },
      { name: "Pro", position: 1, amount: 10, currency: "USD", period: "year", unit: "seat", features: ["SSO", "API access"], rates: [{ text: "$3 / 1k", amount: 3, currency: "USD" }] },
      { name: "Scale", position: 2, amount: 900, currency: "USD", period: "month", features: [] },
    ],
  };
  const types = diffPricing(before, after).events.map((event) => event.type).sort();
  for (const expected of ["free_tier_removed", "price_up", "period_changed", "unit_changed", "trial_removed", "feature_added", "feature_removed", "rate_changed", "promo_added", "promo_removed", "plan_removed", "plan_added"]) {
    assert.ok(types.includes(expected as never), `expected ${expected} in ${types.join(", ")}`);
  }
  assert.ok(!types.includes("plan_renamed" as never), "Legacy and Scale differ in price and features, so they are not paired");
});

void test("currency changes are reported without conversion", () => {
  const events = diffPricing(table({ name: "Pro", amount: 100, currency: "EUR" }), table({ name: "Pro", amount: 110, currency: "USD" })).events;
  assert.deepEqual(events.map((event) => event.type), ["currency_changed"]);
  assert.match(events[0]?.description ?? "", /no conversion/u);
  assert.equal(describePrice({ name: "x", position: 0, amount: 4000, maxAmount: 6500, currency: "EUR", features: [] }), "EUR 4,000 to EUR 6,500");
});
