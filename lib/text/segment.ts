import type { Segment } from "./normalize";

/**
 * Splits contract text into clauses on headings, then packs clauses into
 * chunks of about 1,000 tokens (PRD A4.1). The same clause list feeds version
 * comparison (B3.1), so retrieval and comparison agree on what a clause is.
 */

export interface Clause extends Segment {
  /** "14.2", "Article IV", "Schedule 2", or "" for the preamble. */
  number: string;
  heading: string;
  /** 1 for a top-level heading, 2 for "14.2", and so on. */
  depth: number;
}

export interface Chunk extends Segment {
  ordinal: number;
  section: string;
  heading: string;
  text: string;
}

/** A structural hint from extraction, e.g. a Word heading or an auto-numbered list item. */
export interface LineHint {
  offset: number;
  number?: string;
  headingLevel?: number;
}

export const TARGET_TOKENS = 1000;
const MAX_TOKENS = 1300;
const MIN_TOKENS = 300;
const OVERLAP_CHARS = 200;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const NAMED = /^(ARTICLE|Article|SECTION|Section|CLAUSE|Clause|SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|ANNEXURE|Annexure|APPENDIX|Appendix|PART|Part)\s+([A-Z]{1,5}|[IVXLC]+|\d+(?:\.\d+)*)\b\s*[.:–—-]?\s*(.*)$/;
const NUMBERED = /^(\d{1,3}(?:\.\d{1,3}){0,4})(\.?)[ \t]+(\S.*)$/;
const TOP_LEVEL_WORDS = new Set(["article", "schedule", "exhibit", "annex", "annexure", "appendix", "part"]);

interface Candidate {
  number: string;
  rest: string;
  depth: number;
  numeric: number[] | null;
}

function parseHeadingLine(line: string): Candidate | null {
  const named = NAMED.exec(line);
  if (named) {
    const word = named[1].toLowerCase();
    const label = `${named[1][0].toUpperCase()}${word.slice(1)} ${named[2]}`;
    const rest = named[3].trim();
    // "Section 4 of the Agreement" in running text is a reference, not a heading.
    if (rest && /^[a-z]/.test(rest)) return null;
    if (word === "section" || word === "clause") {
      const numeric = /^\d/.test(named[2]) ? named[2].split(".").map(Number) : null;
      return { number: named[2], rest, depth: numeric?.length ?? 1, numeric };
    }
    return { number: label, rest, depth: TOP_LEVEL_WORDS.has(word) ? 1 : 2, numeric: null };
  }

  const numbered = NUMBERED.exec(line);
  if (numbered) {
    const numeric = numbered[1].split(".").map(Number);
    const rest = numbered[3].trim();
    const hasDot = numbered[2] === "." || numeric.length > 1;
    // "30 days after the date" is a wrapped line, not clause 30.
    if (!hasDot) return null;
    if (!/^[A-Z("'“‘\[]/.test(rest)) return null;
    return { number: numbered[1], rest, depth: numeric.length, numeric };
  }
  return null;
}

/** True when a heading numbered `next` can directly follow one numbered `prev`. */
function follows(prev: number[], next: number[]): boolean {
  let common = 0;
  while (common < prev.length && common < next.length && prev[common] === next[common]) common++;
  if (common === next.length) return false; // repeats the previous number or one of its parents
  const step = next[common] - (prev[common] ?? 0);
  if (step < 1 || step > 3) return false; // goes backwards or skips too far
  return next.slice(common + 1).every((n) => n <= 2); // deeper levels start near 1
}

/** A number that can open a fresh sequence: "1", "1.1", "2.01". */
function startsSequence(numeric: number[]): boolean {
  return numeric.every((n) => n <= 2);
}

const RESTART_PENALTY = 8;
const LOOKBACK = 300;

/**
 * Picks which numbered lines are really headings.
 *
 * A line such as "4.2 (Fees) applies" at the start of a wrapped line looks
 * like a heading. Taking lines greedily lets one such line derail the rest of
 * a section, so this keeps the longest sequence that numbers plausibly from
 * start to finish. Numbering may restart at 1 for free after "Schedule 2" and
 * the like, or at a cost elsewhere (a table of contents followed by the body).
 */
function selectNumbered(candidates: { numeric: number[]; resetBefore: number }[]): boolean[] {
  const n = candidates.length;
  const best = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  // prefixBest[i] is the index of the best-scoring candidate among the first i.
  const prefixBest = new Int32Array(n + 1).fill(-1);

  for (let i = 0; i < n; i++) {
    const { numeric, resetBefore } = candidates[i];
    best[i] = 1;

    for (let j = Math.max(0, i - LOOKBACK); j < i; j++) {
      if (best[j] + 1 > best[i] && follows(candidates[j].numeric, numeric)) {
        best[i] = best[j] + 1;
        back[i] = j;
      }
    }
    if (startsSequence(numeric)) {
      // Free restart: continue from the best chain that ended before the last named heading.
      const free = prefixBest[resetBefore];
      if (free !== -1 && best[free] + 1 > best[i]) {
        best[i] = best[free] + 1;
        back[i] = free;
      }
      const paid = prefixBest[i];
      if (paid !== -1 && best[paid] + 1 - RESTART_PENALTY > best[i]) {
        best[i] = best[paid] + 1 - RESTART_PENALTY;
        back[i] = paid;
      }
    }
    const prior = prefixBest[i];
    prefixBest[i + 1] = prior === -1 || best[i] >= best[prior] ? i : prior;
  }

  const keep = new Array<boolean>(n).fill(false);
  for (let i = prefixBest[n]; i !== -1; i = back[i]) keep[i] = true;
  return keep;
}

function headingText(rest: string): string {
  const title = /^(.{1,90}?)(?:\.(?:\s|$)|:|$)/.exec(rest)?.[1] ?? "";
  const clean = (title || rest.slice(0, 70)).trim();
  return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
}

/** "Definitions ........ 3": a table-of-contents line, not a heading. */
const TOC_LINE = /(?:\.{3,}|\t|\s{3,})\s*\d{1,4}$/;

interface Start {
  number: string;
  heading: string;
  depth: number;
  offset: number;
  numeric: number[] | null;
}

export function segmentClauses(text: string, hints: LineHint[] = []): Clause[] {
  const hintAt = new Map(hints.map((h) => [h.offset, h]));
  const found: Start[] = [];
  let pos = 0;

  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl).trim();
    const hint = hintAt.get(pos);

    if (line) {
      if (hint?.number) {
        // Auto-numbered in the source file: the number is not in the text.
        found.push({ number: hint.number, heading: headingText(line), depth: hint.number.split(".").length, offset: pos, numeric: null });
      } else {
        const candidate = TOC_LINE.test(line) ? null : parseHeadingLine(line);
        if (candidate) {
          found.push({ number: candidate.number, heading: headingText(candidate.rest), depth: candidate.depth, offset: pos, numeric: candidate.numeric });
        } else if (hint?.headingLevel) {
          found.push({ number: "", heading: headingText(line), depth: hint.headingLevel, offset: pos, numeric: null });
        }
      }
    }
    pos = nl + 1;
  }

  // Numbered lines are only candidates until the sequence check has run.
  const numbered: { numeric: number[]; resetBefore: number }[] = [];
  const numberedIndex: number[] = [];
  let resetBefore = 0;
  found.forEach((start, i) => {
    if (start.numeric) {
      numbered.push({ numeric: start.numeric, resetBefore });
      numberedIndex.push(i);
    } else if (start.depth === 1) {
      resetBefore = numbered.length;
    }
  });
  const keep = selectNumbered(numbered);
  const rejected = new Set(numberedIndex.filter((_, k) => !keep[k]));
  const starts = found.filter((_, i) => !rejected.has(i));

  const clauses: Clause[] = [];
  const firstStart = starts[0]?.offset ?? text.length;
  if (text.slice(0, firstStart).trim()) {
    clauses.push({ number: "", heading: starts.length ? "Preamble" : "", depth: 1, start: 0, end: firstStart });
  }
  starts.forEach((start, i) => {
    clauses.push({
      number: start.number,
      heading: start.heading,
      depth: start.depth,
      start: start.offset,
      end: starts[i + 1]?.offset ?? text.length,
    });
  });
  return clauses;
}

const SENTENCE_END = /[.;:!?]["'”’)\]]?\s+(?=[A-Z("'“‘\[\d])|\n+/g;

/** Offsets in [start, end) where a sentence ends, so a split never lands mid-sentence. */
function sentenceBreaks(text: string, start: number, end: number): number[] {
  const breaks: number[] = [];
  const slice = text.slice(start, end);
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(slice); m; m = SENTENCE_END.exec(slice)) {
    breaks.push(start + m.index + m[0].length);
    if (m[0].length === 0) SENTENCE_END.lastIndex++;
  }
  return breaks;
}

/** Split one over-long clause at sentence ends, with one sentence of overlap. */
function splitLong(text: string, range: Segment): Segment[] {
  const maxChars = TARGET_TOKENS * 4;
  const breaks = sentenceBreaks(text, range.start, range.end);
  const pieces: Segment[] = [];
  let start = range.start;

  while (range.end - start > MAX_TOKENS * 4) {
    const limit = start + maxChars;
    // Last sentence end before the limit; fall back to whitespace for one enormous sentence.
    let cut = -1;
    for (const b of breaks) {
      if (b <= start + 200) continue;
      if (b > limit) break;
      cut = b;
    }
    if (cut === -1) {
      const space = text.lastIndexOf(" ", limit);
      cut = space > start + 200 ? space + 1 : limit;
    }
    pieces.push({ start, end: cut });

    // Carry the last sentence over so a point made across the cut is in both pieces.
    let overlapStart = cut;
    for (const b of breaks) {
      if (b >= cut) break;
      if (b >= cut - OVERLAP_CHARS && b > start) {
        overlapStart = b;
        break;
      }
    }
    start = overlapStart;
  }
  pieces.push({ start, end: range.end });
  return pieces;
}

export function buildChunks(text: string, clauses: Clause[]): Chunk[] {
  const chunks: Chunk[] = [];
  const emit = (range: Segment, lead: Clause) => {
    const body = text.slice(range.start, range.end);
    if (!body.trim()) return;
    chunks.push({
      ordinal: chunks.length,
      section: lead.number,
      heading: lead.heading,
      start: range.start,
      end: range.end,
      text: body,
    });
  };

  let group: Clause[] = [];
  const flush = () => {
    if (!group.length) return;
    // A chunk that opens with the preamble but holds numbered clauses is labelled by its first clause.
    const lead = group[0].number ? group[0] : (group.find((c) => c.number) ?? group[0]);
    emit({ start: group[0].start, end: group[group.length - 1].end }, lead);
    group = [];
  };
  const groupTokens = () => (group.length ? estimateTokens(text.slice(group[0].start, group[group.length - 1].end)) : 0);

  for (const clause of clauses) {
    const tokens = estimateTokens(text.slice(clause.start, clause.end));

    if (tokens > MAX_TOKENS) {
      flush();
      for (const piece of splitLong(text, clause)) emit(piece, clause);
      continue;
    }
    const current = groupTokens();
    // Keep a section together, but start a new chunk at a top-level heading once this one has some weight.
    if (current + tokens > MAX_TOKENS || (clause.depth === 1 && current >= MIN_TOKENS)) flush();
    group.push(clause);
  }
  flush();
  return chunks;
}

/** Page numbers (1-based) that a text range touches. `pages` are sorted page ranges. */
export function pagesOf(range: Segment, pages: Segment[]): { from: number; to: number } | null {
  if (!pages.length) return null;
  let from = -1;
  let to = -1;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].end <= range.start) continue;
    if (pages[i].start >= range.end) break;
    if (from === -1) from = i + 1;
    to = i + 1;
  }
  return from === -1 ? null : { from, to };
}

export function sectionLabel(section: string, heading: string): string {
  if (!section) return heading || "Preamble";
  const label = /^\d/.test(section) ? `§${section}` : section;
  return heading ? `${label} ${heading}` : label;
}
