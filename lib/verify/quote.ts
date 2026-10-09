import { keyRangeToOriginal, normalizeWithMap, type NormalizedText, type Segment } from "../text/normalize";


/** Keys shorter than this prove nothing ("the Supplier shall"). */
export const MIN_KEY_LENGTH = 25;
/** Each side of an ellipsis must still be a recognisable fragment. */
export const MIN_PART_KEY_LENGTH = 8;
/** After an ellipsis, the next part must start within this many normalised characters. */
export const ELLIPSIS_WINDOW = 600;

export type UnverifiedReason = "empty" | "too_short" | "not_found";

export interface QuoteMatch {
  /** Start of the first segment and end of the last, in canonical text offsets. */
  start: number;
  end: number;
  /** Contiguous pieces of document text. More than one when the quote had an ellipsis or crossed a running header. */
  segments: Segment[];
}

export interface VerifyResult {
  verified: boolean;
  reason?: UnverifiedReason;
  /** Document text when verified; the model's cleaned text otherwise. */
  displayText: string;
  matches: QuoteMatch[];
  /** Index into `matches`, or -1. */
  primary: number;
}

export interface VerifiableDoc {
  text: string;
  key: string;
  map: Uint32Array;
  /** Running headers and footers, sorted. */
  boilerplate: Segment[];
  /** Built on first use: the key with boilerplate removed. */
  stripped?: NormalizedText;
}

export function makeVerifiableDoc(text: string, boilerplate: Segment[] = []): VerifiableDoc {
  const { key, map } = normalizeWithMap(text);
  return { text, key, map, boilerplate };
}

const ELLIPSIS = /\s*(?:\[\s*(?:\.{3,}|…)\s*\]|\(\s*(?:\.{3,}|…)\s*\)|\.{3,}|…|\.\s\.\s\.)\s*/;
const EDGE_JUNK = /^[\s"'“”‘’«»`.,;:!?…]+|[\s"'“”‘’«»`.,;:!?…]+$/g;

const QUOTE_MARK = /["'“”‘’«»`]/;

/** Step 2: strip wrapping quote marks and edge punctuation, split on internal ellipses. */
export function splitQuote(raw: string): string[] {
  return raw
    .replace(/<[^>]*>/g, " ")
    .split(ELLIPSIS)
    .map((part) => part.replace(EDGE_JUNK, ""))
    .filter((part) => part.length > 0);
}

/**
 * Cleaning strips a quote mark the model put at the edge of its quote. If the
 * document has one in the same place, the match grows by that one character so
 * the displayed text isn't left with half a pair of quote marks.
 */
function widenOverQuoteMarks(text: string, raw: string, segments: Segment[]): void {
  const trimmed = raw.replace(/<[^>]*>/g, " ").trim();
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (QUOTE_MARK.test(trimmed[0] ?? "") && first.start > 0 && QUOTE_MARK.test(text[first.start - 1])) {
    first.start -= 1;
  }
  const tail = trimmed.replace(/[\s.,;:!?…]+$/, "");
  if (QUOTE_MARK.test(tail[tail.length - 1] ?? "") && last.end < text.length && QUOTE_MARK.test(text[last.end])) {
    last.end += 1;
  }
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    hits.push(at);
  }
  return hits;
}

/** Every way the parts occur in order in `key`, as [start, end) key ranges per part. */
function findChains(key: string, parts: string[]): Segment[][] {
  const chains: Segment[][] = [];
  for (const first of findAll(key, parts[0])) {
    const chain: Segment[] = [{ start: first, end: first + parts[0].length }];
    for (let p = 1; p < parts.length; p++) {
      const from = chain[p - 1].end;
      const at = key.indexOf(parts[p], from);
      if (at === -1 || at > from + ELLIPSIS_WINDOW) break;
      chain.push({ start: at, end: at + parts[p].length });
    }
    if (chain.length === parts.length) chains.push(chain);
  }
  return chains;
}

function subtract(range: Segment, holes: Segment[]): Segment[] {
  const out: Segment[] = [];
  let cursor = range.start;
  for (const hole of holes) {
    if (hole.end <= cursor) continue;
    if (hole.start >= range.end) break;
    if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < range.end) out.push({ start: cursor, end: range.end });
  return out;
}

function trimSegment(text: string, seg: Segment): Segment | null {
  let { start, end } = seg;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { start, end } : null;
}

/** The document's words for one segment: line breaks become spaces, a hyphenated break keeps its hyphen. */
export function displaySlice(text: string, seg: Segment): string {
  return text
    .slice(seg.start, seg.end)
    .replace(/([\-‐‑])\s*\n\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface Located {
  match: QuoteMatch;
  display: string;
}

function locate(doc: VerifiableDoc, norm: NormalizedText, chain: Segment[], holes: Segment[], raw: string): Located {
  const parts = chain.map((keyRange) => {
    const original = keyRangeToOriginal(doc.text, norm.map, keyRange.start, keyRange.end);
    return subtract(original, holes)
      .map((piece) => trimSegment(doc.text, piece))
      .filter((piece): piece is Segment => piece !== null);
  });
  const segments = parts.flat();
  widenOverQuoteMarks(doc.text, raw, segments);
  return {
    match: { start: segments[0].start, end: segments[segments.length - 1].end, segments },
    // Pieces either side of a removed header read as one sentence; an ellipsis stays an ellipsis.
    display: parts.map((pieces) => pieces.map((piece) => displaySlice(doc.text, piece)).join(" ")).join(" … "),
  };
}

function strippedKey(doc: VerifiableDoc): NormalizedText {
  doc.stripped ??= normalizeWithMap(doc.text, doc.boilerplate);
  return doc.stripped;
}

export interface VerifyOptions {
  /** Ranges of text the model was actually given. An occurrence inside one becomes the primary. */
  preferred?: Segment[];
}

export function verifyQuote(raw: string, doc: VerifiableDoc, options: VerifyOptions = {}): VerifyResult {
  const cleaned = splitQuote(raw);
  const fallbackDisplay = cleaned.join(" … ") || raw.trim();
  const fail = (reason: UnverifiedReason): VerifyResult => ({
    verified: false,
    reason,
    displayText: fallbackDisplay,
    matches: [],
    primary: -1,
  });

  const parts = cleaned.map((part) => normalizeWithMap(part).key).filter((key) => key.length > 0);
  if (parts.length === 0) return fail("empty");

  const total = parts.reduce((sum, key) => sum + key.length, 0);
  if (total < MIN_KEY_LENGTH) return fail("too_short");
  if (parts.length > 1 && parts.some((key) => key.length < MIN_PART_KEY_LENGTH)) return fail("too_short");

  // Step 4: the document as extracted.
  let located = findChains(doc.key, parts).map((chain) => locate(doc, doc, chain, [], raw));

  // Step 5: retry with running headers, footers and page numbers removed.
  if (located.length === 0 && doc.boilerplate.length > 0) {
    const stripped = strippedKey(doc);
    located = findChains(stripped.key, parts).map((chain) => locate(doc, stripped, chain, doc.boilerplate, raw));
  }
  if (located.length === 0) return fail("not_found");

  // Step 7: prefer an occurrence inside text the model was given.
  let primary = 0;
  if (options.preferred?.length) {
    const inside = located.findIndex(({ match }) =>
      options.preferred!.some((range) => match.start >= range.start && match.start < range.end),
    );
    if (inside !== -1) primary = inside;
  }

  return {
    verified: true,
    displayText: located[primary].display,
    matches: located.map((l) => l.match),
    primary,
  };
}
