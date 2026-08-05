export interface RobotsRules {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
}

/**
 * Minimal robots.txt parser.
 *
 * Collects the `Allow`/`Disallow` rules that apply to the `*` user-agent group
 * (the conservative choice for a generic agent) plus any global `Sitemap:`
 * directives. This is intentionally simple — it is used to *refuse* disallowed
 * fetches, not to maximize crawl coverage.
 */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  let appliesToStar = false;
  let sawUserAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case "user-agent": {
        // A run of consecutive user-agent lines shares the following rules.
        if (sawUserAgent && (rules.allow.length > 0 || rules.disallow.length > 0)) {
          appliesToStar = false;
          sawUserAgent = false;
        }
        if (value === "*") appliesToStar = true;
        sawUserAgent = true;
        break;
      }
      case "disallow":
        if (appliesToStar && value) rules.disallow.push(value);
        break;
      case "allow":
        if (appliesToStar && value) rules.allow.push(value);
        break;
      case "sitemap":
        if (value) rules.sitemaps.push(value);
        break;
      default:
        break;
    }
  }
  return rules;
}

function matchLength(pathname: string, rule: string): number {
  // Support the common `*` wildcard and `$` end-anchor from the robots spec.
  const hasEnd = rule.endsWith("$");
  const pattern = hasEnd ? rule.slice(0, -1) : rule;
  const segments = pattern.split("*");
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    if (segment === "") continue;
    const found = pathname.indexOf(segment, cursor);
    if (found === -1) return -1;
    if (i === 0 && found !== 0) return -1;
    cursor = found + segment.length;
  }
  if (hasEnd && cursor !== pathname.length) return -1;
  return pattern.replace(/\*/g, "").length;
}

/**
 * Decide whether a path may be fetched. Longest matching rule wins; an `Allow`
 * of equal specificity beats a `Disallow`. No matching rule means allowed.
 */
export function isPathAllowed(rules: RobotsRules, pathname: string): boolean {
  let bestDisallow = -1;
  let bestAllow = -1;
  for (const rule of rules.disallow) bestDisallow = Math.max(bestDisallow, matchLength(pathname, rule));
  for (const rule of rules.allow) bestAllow = Math.max(bestAllow, matchLength(pathname, rule));
  if (bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}
