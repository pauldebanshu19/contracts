import type { Clause } from "../text/segment";

/**
 * Clause alignment between two versions (PRD B3.1–B3.3).
 *
 * Pairs are found by number and heading first, then by text similarity, which
 * catches clauses that were renumbered or moved. What is left over was added
 * or removed.
 */

export interface VersionClause extends Clause {
  /** Clause text without its own number, so renumbering doesn't read as a change. */
  body: string;
}

export type PairType = "unchanged" | "cosmetic" | "modified" | "added" | "removed" | "moved";

export interface ClausePair {
  type: PairType;
  a: VersionClause | null;
  b: VersionClause | null;
  /** The clause's number changed. */
  renumbered: boolean;
  /** The clause changed places relative to the clauses around it (not just its number). */
  relocated: boolean;
  similarity: number;
}

const SAME_NUMBER_MIN = 0.3;
const SIMILAR_MIN = 0.5;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "12. ", "Section 12.1 ", "ARTICLE IV ": the clause's own number at the start of its text. */
function numberPrefix(number: string): RegExp {
  const escaped = escapeRegExp(number);
  return /^\d/.test(number)
    ? new RegExp(`^(?:(?:section|clause)\\s+)?${escaped}\\.?\\s*`, "i")
    : new RegExp(`^${escaped}\\b\\s*[.:\\u2013\\u2014-]?\\s*`, "i");
}

export function toVersionClauses(text: string, clauses: Clause[]): VersionClause[] {
  return clauses
    .map((clause) => {
      const raw = text.slice(clause.start, clause.end).trim();
      const body = clause.number ? raw.replace(numberPrefix(clause.number), "") : raw;
      return { ...clause, body };
    })
    .filter((clause) => clause.body.length > 0);
}

/** Letters and digits only: what is left when formatting and punctuation are ignored. */
export function contentKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Words every clause shares; counting them would make unrelated clauses look alike.
const STOPWORDS = new Set(
  "a an and any are as at be by for from has have in is it its may not of on or other shall such that the this to under which will with".split(" "),
);

function words(text: string): Set<string> {
  const all = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N},%]*/gu) ?? [];
  return new Set(all.map((w) => w.replace(/[,.]+$/, "")).filter((w) => !STOPWORDS.has(w)));
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

function headingKey(clause: VersionClause): string {
  return clause.heading.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Indices (into `values`) of a longest increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails[tails.length - 1] ?? -1; i !== -1; i = prev[i]) keep.add(i);
  return keep;
}

export function alignClauses(aClauses: VersionClause[], bClauses: VersionClause[]): ClausePair[] {
  const aWords = aClauses.map((c) => words(c.body));
  const bWords = bClauses.map((c) => words(c.body));
  const matchOfA = new Array<number>(aClauses.length).fill(-1);
  const matchOfB = new Array<number>(bClauses.length).fill(-1);
  const sim = new Map<string, number>();
  const score = (i: number, j: number) => {
    const key = `${i}:${j}`;
    let value = sim.get(key);
    if (value === undefined) {
      value = similarity(aWords[i], bWords[j]);
      sim.set(key, value);
    }
    return value;
  };
  const pair = (i: number, j: number) => {
    matchOfA[i] = j;
    matchOfB[j] = i;
  };

  // 1. Same number and same heading. A table of contents can repeat a number, so each side is used once.
  const byKey = new Map<string, number[]>();
  bClauses.forEach((c, j) => {
    if (!c.number) return;
    const key = `${c.number}|${headingKey(c)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), j]);
  });
  aClauses.forEach((c, i) => {
    if (!c.number) return;
    const candidates = byKey.get(`${c.number}|${headingKey(c)}`) ?? [];
    const j = candidates.find((k) => matchOfB[k] === -1);
    if (j !== undefined) pair(i, j);
  });

  // 2. Same heading under a new number: renumbered or moved. Only when the heading is unambiguous on both sides.
  const unmatchedHeadings = (list: VersionClause[], matches: number[]) => {
    const counts = new Map<string, number>();
    list.forEach((c, k) => {
      const key = headingKey(c);
      if (matches[k] === -1 && key) counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return counts;
  };
  const aHeadings = unmatchedHeadings(aClauses, matchOfA);
  const bHeadings = unmatchedHeadings(bClauses, matchOfB);
  aClauses.forEach((c, i) => {
    const key = headingKey(c);
    if (matchOfA[i] !== -1 || !key || aHeadings.get(key) !== 1 || bHeadings.get(key) !== 1) return;
    const j = bClauses.findIndex((d, k) => matchOfB[k] === -1 && headingKey(d) === key);
    if (j !== -1 && score(i, j) >= SAME_NUMBER_MIN) pair(i, j);
  });

  // 3. Same number, new heading, recognisably the same clause, and no better partner on either side.
  const MARGIN = 0.1;
  aClauses.forEach((c, i) => {
    if (matchOfA[i] !== -1 || !c.number) return;
    const j = bClauses.findIndex((d, k) => matchOfB[k] === -1 && d.number === c.number);
    if (j === -1 || score(i, j) < SAME_NUMBER_MIN) return;
    const bestForA = Math.max(...bClauses.map((_, k) => (matchOfB[k] === -1 ? score(i, k) : 0)));
    const bestForB = Math.max(...aClauses.map((_, m) => (matchOfA[m] === -1 ? score(m, j) : 0)));
    if (score(i, j) >= bestForA - MARGIN && score(i, j) >= bestForB - MARGIN) pair(i, j);
  });

  // 4. Anything else (including the unnumbered preamble) by similarity, best pairs first.
  const candidates: [number, number, number][] = [];
  aClauses.forEach((_, i) => {
    if (matchOfA[i] !== -1) return;
    bClauses.forEach((_, j) => {
      if (matchOfB[j] !== -1) return;
      const s = score(i, j);
      if (s >= SIMILAR_MIN) candidates.push([s, i, j]);
    });
  });
  candidates.sort((x, y) => y[0] - x[0]);
  for (const [, i, j] of candidates) if (matchOfA[i] === -1 && matchOfB[j] === -1) pair(i, j);

  // A pair is "moved" only if it is out of order relative to the other pairs; a new number alone is renumbering.
  const matchedA = aClauses.map((_, i) => i).filter((i) => matchOfA[i] !== -1);
  const inOrder = longestIncreasing(matchedA.map((i) => matchOfA[i]));
  const inPlace = new Set(matchedA.filter((_, k) => inOrder.has(k)));

  const pairs: ClausePair[] = [];
  aClauses.forEach((a, i) => {
    const j = matchOfA[i];
    if (j === -1) {
      pairs.push({ type: "removed", a, b: null, renumbered: false, relocated: false, similarity: 0 });
      return;
    }
    const b = bClauses[j];
    const renumbered = a.number !== b.number;
    const s = score(i, j);
    let type: PairType;
    if (a.body === b.body && !renumbered) type = "unchanged";
    else if (contentKey(a.body) === contentKey(b.body)) type = inPlace.has(i) ? (renumbered ? "moved" : "cosmetic") : "moved";
    else type = inPlace.has(i) ? "modified" : "moved";
    pairs.push({ type, a, b, renumbered, relocated: !inPlace.has(i), similarity: s });
  });
  bClauses.forEach((b, j) => {
    if (matchOfB[j] === -1) pairs.push({ type: "added", a: null, b, renumbered: false, relocated: false, similarity: 0 });
  });

  return sortByDocumentOrder(pairs);
}

/** Order changes as they appear in the newer version; removed clauses sit where they used to be. */
function sortByDocumentOrder(pairs: ClausePair[]): ClausePair[] {
  const keyed: { pair: ClausePair; key: number; tie: number }[] = [];
  let lastB = -1;
  let tie = 0;
  // Pairs arrive in the old version's order, then additions; a removal goes after the last matched clause.
  for (const pair of pairs) {
    if (pair.b) {
      if (pair.a) lastB = pair.b.start;
      keyed.push({ pair, key: pair.b.start, tie: 0 });
    } else {
      keyed.push({ pair, key: lastB + 0.5, tie: ++tie });
    }
  }
  return keyed.sort((x, y) => x.key - y.key || x.tie - y.tie).map((k) => k.pair);
}
