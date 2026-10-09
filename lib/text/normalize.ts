/**
 * One normaliser for both sides of quote verification (PRD "Quote verification", step 3).
 *
 * The key drops everything that extraction or a model can legitimately get
 * wrong (whitespace, hyphenation, quote-mark style, case) and keeps everything
 * that carries meaning (letters, digits, punctuation). `map` takes every key
 * character back to the original string, so a match in the key can be shown in
 * the document's own words.
 */

export interface Segment {
  start: number;
  end: number;
}

export interface NormalizedText {
  key: string;
  /** map[i] is the offset in the original text of the cluster that produced key[i]. */
  map: Uint32Array;
}

const COMBINING_MARK = /\p{M}/u;

// Single and double quote variants, folded to ' and ".
const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′", "ʼ", "`", "´"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″", "«", "»"]);

function isDropped(code: number): boolean {
  // ASCII whitespace and the hyphen-minus.
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0x2d) return true;
  if (code < 0x80) return false;
  return (
    code === 0x00a0 || // no-break space
    code === 0x00ad || // soft hyphen
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200f) || // spaces, zero-width, direction marks
    (code >= 0x2010 && code <= 0x2015) || // hyphens, en and em dashes
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x2060 || // word joiner
    code === 0x2212 || // minus sign
    code === 0x2e3a ||
    code === 0x2e3b ||
    code === 0x3000 ||
    code === 0xfe58 ||
    code === 0xfe63 ||
    code === 0xfeff || // BOM / zero-width no-break space
    code === 0xff0d
  );
}

/** End offset of the cluster (code point plus trailing combining marks) starting at `index`. */
export function clusterEnd(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const cp = text.codePointAt(index)!;
  let end = index + (cp > 0xffff ? 2 : 1);
  while (end < text.length) {
    const next = text.codePointAt(end)!;
    if (next < 0x300) break;
    const ch = String.fromCodePoint(next);
    if (!COMBINING_MARK.test(ch)) break;
    end += ch.length;
  }
  return end;
}

function inSkip(skip: Segment[], cursor: { i: number }, offset: number): number {
  // Returns the end of the skip range containing `offset`, or -1. `skip` is sorted.
  while (cursor.i < skip.length && skip[cursor.i].end <= offset) cursor.i++;
  const range = skip[cursor.i];
  return range && range.start <= offset ? range.end : -1;
}

/**
 * Normalise `text`, keeping the map back to the original.
 * `skip` (sorted, non-overlapping) removes ranges such as running headers
 * before normalising, while the map still points into the full text.
 */
export function normalizeWithMap(text: string, skip: Segment[] = []): NormalizedText {
  const out: number[] = [];
  const map: number[] = [];
  const cursor = { i: 0 };
  let i = 0;
  const n = text.length;

  while (i < n) {
    if (skip.length) {
      const skipEnd = inSkip(skip, cursor, i);
      if (skipEnd !== -1) {
        i = skipEnd;
        continue;
      }
    }
    const code = text.charCodeAt(i);

    // Fast path: plain ASCII not followed by a combining mark.
    if (code < 0x80 && (i + 1 >= n || text.charCodeAt(i + 1) < 0x300)) {
      if (!isDropped(code)) {
        if (code === 0x60) out.push(0x27); // backtick
        else out.push(code >= 0x41 && code <= 0x5a ? code + 32 : code);
        map.push(i);
      }
      i++;
      continue;
    }

    const end = clusterEnd(text, i);
    const folded = text.slice(i, end).normalize("NFKC").toLowerCase();
    for (let k = 0; k < folded.length; k++) {
      const c = folded.charCodeAt(k);
      if (isDropped(c)) continue;
      const ch = folded[k];
      if (SINGLE_QUOTES.has(ch)) out.push(0x27);
      else if (DOUBLE_QUOTES.has(ch)) out.push(0x22);
      else out.push(c);
      map.push(i);
    }
    i = end;
  }

  let key = "";
  const CHUNK = 8192;
  for (let p = 0; p < out.length; p += CHUNK) {
    key += String.fromCharCode.apply(null, out.slice(p, p + CHUNK));
  }
  return { key, map: Uint32Array.from(map) };
}

export function normalizeKey(text: string): string {
  return normalizeWithMap(text).key;
}

/** Original-text range covered by key[start, end). */
export function keyRangeToOriginal(text: string, map: Uint32Array, start: number, end: number): Segment {
  return { start: map[start], end: clusterEnd(text, map[end - 1]) };
}
