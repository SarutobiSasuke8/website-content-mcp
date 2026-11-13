/**
 * Competitor-intelligence signals read from a page: open roles, integration and
 * partner names, security certifications, release entries and the page's hero
 * positioning. All are observed text, bounded in size and never inferred.
 */

export interface RoleFact {
  title: string;
  href?: string;
  department?: string;
  location?: string;
}

export interface ReleaseFact {
  title: string;
  date?: string;
}

export interface HeroFact {
  h1?: string;
  description?: string;
  /** First calls to action in document order. */
  ctas: string[];
  /** The first paragraph after the H1, clipped. */
  lead?: string;
}

export type WatchKind = "general" | "pricing" | "changelog" | "blog" | "careers" | "integrations" | "security";

const MAX_ROLES = 100;
const MAX_NAMES = 200;
const MAX_RELEASES = 40;

const JOB_HREF = /(?:jobs?|careers?|positions?|openings?|vacanc|opportunit|apply|greenhouse\.io|lever\.co|ashbyhq|workable|bamboohr|recruitee|teamtailor|smartrecruiters|breezy\.hr|personio)/iu;
const GENERIC_LINK = /^(?:careers?|jobs?|apply(?: now)?|view (?:all )?(?:jobs|roles|openings)|see (?:all )?(?:jobs|roles|openings)|open roles|all jobs|learn more|read more|back|home|contact(?: us)?|about(?: us)?|sign (?:in|up)|log ?in|menu|search)$/iu;
const CERTIFICATIONS: [string, RegExp][] = [
  ["SOC 2", /\bSOC\s?2\b/iu],
  ["ISO 27001", /\bISO\/?(?:IEC)?\s?27001\b/iu],
  ["ISO 27701", /\bISO\/?(?:IEC)?\s?27701\b/iu],
  ["ISO 9001", /\bISO\s?9001\b/iu],
  ["GDPR", /\bGDPR\b/iu],
  ["HIPAA", /\bHIPAA\b/iu],
  ["PCI DSS", /\bPCI[\s-]?DSS\b/iu],
  ["FedRAMP", /\bFedRAMP\b/iu],
  ["Cyber Essentials", /\bCyber Essentials\b/iu],
  ["CSA STAR", /\bCSA STAR\b/iu],
  ["DPA", /\bdata processing (?:agreement|addendum)\b/iu],
  ["Sub-processor list", /\bsub-?processors?\b/iu],
  ["Penetration testing", /\bpen(?:etration)?[\s-]?test/iu],
  ["Bug bounty", /\bbug bounty\b/iu],
  ["SSO", /\bsingle sign-?on\b|\bSAML\b/iu],
];
const RELEASE_HEADING = /\bv?\d+\.\d+(?:\.\d+)?\b|\b20\d{2}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+20\d{2}\b/iu;
const DATE_IN_TEXT = /\b(20\d{2}-\d{2}-\d{2})\b|\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})\b|\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+20\d{2})\b/iu;

function norm(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/gu, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function absolute(href: string | null, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || /^(?:javascript|data|vbscript|mailto|tel):/iu.test(trimmed) || trimmed.startsWith("#")) return undefined;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Open roles: links to job postings, with the nearest heading as the department. */
export function rolesOf(doc: Document, base: string): RoleFact[] {
  const roles: RoleFact[] = [];
  const seen = new Set<string>();
  let department: string | undefined;
  for (const element of Array.from(doc.body?.querySelectorAll("h2, h3, h4, a[href]") ?? [])) {
    if (/^H[2-4]$/u.test(element.tagName)) {
      const text = norm(element.textContent);
      department = text && text.length <= 60 ? text : undefined;
      continue;
    }
    if (element.closest("nav, header, footer")) continue;
    const href = absolute(element.getAttribute("href"), base);
    const title = norm(element.querySelector("h1, h2, h3, h4, h5, h6, strong, [class*='title' i]")?.textContent) || norm(element.textContent);
    if (!href || !title || title.length < 3 || title.length > 120 || GENERIC_LINK.test(title)) continue;
    if (!JOB_HREF.test(href)) continue;
    const key = `${title}\u0000${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const container = element.closest("li, tr, article") ?? element.parentElement;
    const rest = norm(container?.textContent).replace(title, "").replace(/^[\s\-–·|,:]+/u, "");
    const role: RoleFact = { title: clip(title, 120), href };
    if (department && !/^(?:open (?:roles|positions)|careers?|jobs?|join us)/iu.test(department)) role.department = department;
    if (rest && rest.length <= 60) role.location = rest;
    roles.push(role);
    if (roles.length >= MAX_ROLES) break;
  }
  return roles;
}

/** Names listed on an integrations or partners page: logo alt text, link text and card titles. */
export function integrationNamesOf(doc: Document): string[] {
  const names: string[] = [];
  const add = (raw: string | null | undefined): void => {
    const text = norm(raw);
    if (!text || text.length < 2 || text.length > 40 || /^(?:learn more|read more|view|see|all|logo|image|icon|partner|integration)s?\b/iu.test(text)) return;
    if (!names.some((name) => name.toLowerCase() === text.toLowerCase())) names.push(text);
  };
  for (const element of Array.from(doc.body?.querySelectorAll("img[alt], h3, h4, li > a, a[href] > span, [class*='integration' i] a, [class*='partner' i] a") ?? [])) {
    if (element.closest("nav, header, footer")) continue;
    add(element.tagName === "IMG" ? element.getAttribute("alt")?.replace(/\s*logo$/iu, "") : element.textContent);
    if (names.length >= MAX_NAMES) break;
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Certifications and trust mechanisms the page mentions, by fixed vocabulary. */
export function certificationsOf(doc: Document): string[] {
  const text = norm(doc.body?.textContent);
  return CERTIFICATIONS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** Release or changelog entries: headings that carry a version number or a date. */
export function releasesOf(doc: Document): ReleaseFact[] {
  const releases: ReleaseFact[] = [];
  const seen = new Set<string>();
  for (const heading of Array.from(doc.body?.querySelectorAll("h2, h3, h4") ?? [])) {
    const text = norm(heading.textContent);
    if (!text || text.length > 120 || !RELEASE_HEADING.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const date = DATE_IN_TEXT.exec(text) ?? DATE_IN_TEXT.exec(norm(heading.nextElementSibling?.textContent).slice(0, 80));
    const release: ReleaseFact = { title: text };
    const stamp = date?.[1] ?? date?.[2] ?? date?.[3] ?? heading.querySelector("time")?.getAttribute("datetime") ?? undefined;
    if (stamp) release.date = stamp;
    releases.push(release);
    if (releases.length >= MAX_RELEASES) break;
  }
  return releases;
}

/** The lines a visitor reads first: H1, meta description, first calls to action and the lead paragraph. */
export function heroOf(doc: Document, ctas: { text: string }[]): HeroFact | undefined {
  const h1 = norm(doc.querySelector("h1")?.textContent);
  const description = norm(doc.querySelector('meta[name="description" i]')?.getAttribute("content"));
  const lead = norm(doc.querySelector("h1")?.parentElement?.querySelector("h1 ~ p, h1 ~ div > p")?.textContent);
  const hero: HeroFact = { ctas: ctas.slice(0, 3).map((cta) => cta.text) };
  if (h1) hero.h1 = clip(h1, 200);
  if (description) hero.description = clip(description, 400);
  if (lead) hero.lead = clip(lead, 240);
  return hero.h1 || hero.description || hero.ctas.length > 0 ? hero : undefined;
}
