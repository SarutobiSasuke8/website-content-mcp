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
