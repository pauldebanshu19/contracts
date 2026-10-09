import type { Segment } from "./normalize";

/**
 * Running headers, footers and page numbers: lines in the top or bottom few
 * lines of a page that repeat on more than half the pages. Digits are folded
 * so "Page 3 of 150" and "Page 4 of 150" count as the same line.
 *
 * Used only for the verifier's second attempt, so a quote that runs across a
 * page break can still be found. It never changes the stored text.
 */

const EDGE_LINES = 3;
/** Headers and footers are short. A full-width line is body text, however often its shape repeats. */
const MAX_LINE = 70;

function signature(line: string): string {
  const trimmed = line.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_LINE ? "" : trimmed.replace(/\d+/g, "#").toLowerCase();
}

interface Line extends Segment {
  sig: string;
}

function edgeLines(text: string, page: Segment): Line[] {
  const lines: Line[] = [];
  let pos = page.start;
  while (pos < page.end) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1 || nl >= page.end) nl = page.end;
    const sig = signature(text.slice(pos, nl));
    // The range includes the line break, so removing it leaves no gap.
    if (sig) lines.push({ start: pos, end: Math.min(nl + 1, page.end), sig });
    pos = nl + 1;
  }
  if (lines.length <= EDGE_LINES * 2) return lines;
  return [...lines.slice(0, EDGE_LINES), ...lines.slice(-EDGE_LINES)];
}

export function detectBoilerplate(text: string, pages: Segment[]): Segment[] {
  if (pages.length < 2) return [];

  const perPage = pages.map((page) => edgeLines(text, page));
  const pagesWithSig = new Map<string, number>();
  for (const lines of perPage) {
    for (const sig of new Set(lines.map((l) => l.sig))) {
      pagesWithSig.set(sig, (pagesWithSig.get(sig) ?? 0) + 1);
    }
  }

  const threshold = pages.length / 2;
  const ranges: Segment[] = [];
  for (const lines of perPage) {
    for (const line of lines) {
      if ((pagesWithSig.get(line.sig) ?? 0) > threshold) {
        ranges.push({ start: line.start, end: line.end });
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  // Merge touching ranges and swallow the blank gap between a footer and the next header.
  const merged: Segment[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && /^\s*$/.test(text.slice(last.end, range.start))) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
