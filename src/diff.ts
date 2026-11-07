/**
 * Deterministic line diff and plain-English change summary.
 *
 * No model is involved: the output depends only on the two inputs, so the same
 * pair of documents always yields the same diff and the same sentence.
 */

export interface LineDiff {
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
  /** True when the added or removed list was cut to stay within the size bound. */
  truncated: boolean;
}

export interface DiffOptions {
  /** Maximum added and maximum removed lines returned (each). */
  maxLines?: number;
  /** Longest line returned before it is clipped. */
  maxLineChars?: number;
}

const DEFAULT_MAX_LINES = 60;
const DEFAULT_MAX_LINE_CHARS = 240;
/** Largest dynamic-programming table (old lines times new lines) we are willing to build. */
const MAX_LCS_CELLS = 4_000_000;

function toLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter((line) => line.length > 0);
}

/** Lines present in `a` but not matched in `b`, treating both as multisets. */
function multisetMinus(a: string[], b: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const line of b) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const result: string[] = [];
  for (const line of a) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else result.push(line);
  }
  return result;
}

function lcsDiff(oldLines: string[], newLines: string[]): { removed: string[]; added: string[] } {
  const n = oldLines.length;
  const m = newLines.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      removed.push(oldLines[i] as string);
      i += 1;
    } else {
      added.push(newLines[j] as string);
      j += 1;
    }
  }
  while (i < n) removed.push(oldLines[i++] as string);
  while (j < m) added.push(newLines[j++] as string);
  return { removed, added };
}

function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Compare two documents line by line, ignoring blank lines and runs of spaces. */
export function diffLines(oldText: string, newText: string, options: DiffOptions = {}): LineDiff {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMiddle = oldLines.slice(start, oldEnd);
  const newMiddle = newLines.slice(start, newEnd);

  const { removed, added } = oldMiddle.length * newMiddle.length <= MAX_LCS_CELLS
    ? lcsDiff(oldMiddle, newMiddle)
    : { removed: multisetMinus(oldMiddle, newMiddle), added: multisetMinus(newMiddle, oldMiddle) };

  return {
    added: added.slice(0, maxLines).map((line) => clip(line, maxLineChars)),
    removed: removed.slice(0, maxLines).map((line) => clip(line, maxLineChars)),
    addedCount: added.length,
    removedCount: removed.length,
    truncated: added.length > maxLines || removed.length > maxLines,
  };
}

const AMOUNT_PATTERN =
  /(?:[€$£]\s?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?[kKmM]\b)?)|(?:\b(?:EUR|USD|GBP)\s?\d(?:[\d,]*\d)?(?:\.\d+)?)|(?:\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:EUR|USD|GBP)\b)/gu;

/** Currency amounts written in text, in order of appearance, with spacing removed. */
export function findAmounts(text: string): string[] {
  return (text.match(AMOUNT_PATTERN) ?? []).map((amount) => amount.replace(/\s+/gu, ""));
}

function distinctAmounts(lines: string[]): string[] {
  return [...new Set(lines.flatMap((line) => findAmounts(line)))];
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function listed(values: string[]): string {
  const shown = values.slice(0, 4).join(", ");
  return values.length > 4 ? `${shown} and ${values.length - 4} more` : shown;
}

/** One plain-English sentence describing a diff. Deterministic. */
export function summarizeDiff(diff: LineDiff, oldTitle?: string, newTitle?: string): string {
  if (diff.addedCount === 0 && diff.removedCount === 0) return "No visible text lines changed.";
  const parts = [`${plural(diff.addedCount, "line")} added and ${plural(diff.removedCount, "line")} removed.`];

  const oldAmounts = distinctAmounts(diff.removed);
  const newAmounts = distinctAmounts(diff.added);
  const gone = oldAmounts.filter((amount) => !newAmounts.includes(amount));
  const appeared = newAmounts.filter((amount) => !oldAmounts.includes(amount));
  if (gone.length > 0 || appeared.length > 0) {
    const bits: string[] = [];
    if (gone.length > 0) bits.push(`no longer shown: ${listed(gone)}`);
    if (appeared.length > 0) bits.push(`now shown: ${listed(appeared)}`);
    parts.push(`Amounts ${bits.join("; ")}.`);
  }

  const headingsAdded = diff.added.filter((line) => /^#{1,6}\s/u.test(line)).length;
  const headingsRemoved = diff.removed.filter((line) => /^#{1,6}\s/u.test(line)).length;
  if (headingsAdded > 0 || headingsRemoved > 0) {
    parts.push(`Headings: ${headingsAdded} added, ${headingsRemoved} removed.`);
  }
  if (oldTitle !== undefined && newTitle !== undefined && oldTitle !== newTitle) {
    parts.push(`Title changed from "${clip(oldTitle, 80)}" to "${clip(newTitle, 80)}".`);
  }
  if (diff.truncated) parts.push("The listed lines are truncated.");
  return parts.join(" ");
}

/**
 * Reduce page text to what is stable between visits, so that a changing date
 * stamp or a re-flowed paragraph does not count as a change when the watcher
 * decides whether a page moved.
 */
export function normalizeForWatch(markdown: string): string {
  const months = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  return markdown
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu, "<date>")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${months}\\.?,?\\s+\\d{4}\\b`, "giu"), "<date>")
    .replace(new RegExp(`\\b${months}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "giu"), "<date>")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gu, "<date>")
    .replace(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?\d{4}/giu, "© <year>")
    .replace(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/giu, "<ago>")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
}
