import { JSDOM } from "jsdom";

export interface SectionHint {
  /** CSS selector; every match is kept. */
  selector?: string;
  /** Heading text (case-insensitive substring); the heading and the content that follows it are kept. */
  section?: string;
}

/**
 * Reduce an HTML page to the part a watcher cares about, keeping the head so
 * title, description and canonical facts still describe the page. Returns
 * undefined when the hint matches nothing, so the caller can say so instead of
 * silently comparing a different part of the page.
 */
export function restrictHtml(html: string, url: string, hint: SectionHint): string | undefined {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const kept: string[] = [];

  if (hint.selector) {
    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(hint.selector));
    } catch {
      throw new Error(`The CSS selector '${hint.selector}' is not valid.`);
    }
    for (const element of matches) kept.push(element.outerHTML);
  } else if (hint.section) {
    const needle = hint.section.trim().toLowerCase();
    const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const start = headings.find((heading) => (heading.textContent ?? "").replace(/\s+/gu, " ").trim().toLowerCase().includes(needle));
    if (start) {
      const level = Number(start.tagName.slice(1));
      kept.push(start.outerHTML);
      for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
        if (/^H[1-6]$/u.test(node.tagName) && Number(node.tagName.slice(1)) <= level) break;
        kept.push(node.outerHTML);
      }
    }
  } else {
    return html;
  }

  if (kept.length === 0) return undefined;
  const head = doc.head?.innerHTML ?? "";
  return `<!doctype html><html><head>${head}</head><body>${kept.join("\n")}</body></html>`;
}

export interface IgnoreRules {
  /** CSS selectors whose matches are removed before anything is read (cookie banners, rotating testimonials). */
  selectors?: string[] | undefined;
  /** Case-insensitive patterns; a leaf element whose whole text matches one is removed (timestamps, counters). */
  text?: string[] | undefined;
}

/** Compile the text patterns once so an invalid one fails with a clear message. */
export function compileIgnoreText(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).map((pattern) => {
    try {
      return new RegExp(pattern, "iu");
    } catch {
      throw new Error(`The ignore pattern '${pattern}' is not a valid regular expression.`);
    }
  });
}

/**
 * Remove noise from a page before it is read. Returns the page unchanged when
 * there is nothing to ignore. A selector that matches nothing is not an error,
 * because the noise may simply be absent today.
 */
export function applyIgnore(html: string, url: string, rules: IgnoreRules): string {
  const patterns = compileIgnoreText(rules.text);
  if ((rules.selectors?.length ?? 0) === 0 && patterns.length === 0) return html;
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  for (const selector of rules.selectors ?? []) {
    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(selector));
    } catch {
      throw new Error(`The ignore selector '${selector}' is not a valid CSS selector.`);
    }
    for (const element of matches) element.remove();
  }
  if (patterns.length > 0 && doc.body) {
    for (const element of Array.from(doc.body.querySelectorAll("*"))) {
      if (element.children.length > 0) continue;
      const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
      if (text && patterns.some((pattern) => pattern.test(text))) element.remove();
    }
  }
  return dom.serialize();
}
