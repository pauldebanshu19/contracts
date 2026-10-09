import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import type { Segment } from "../text/normalize";
import type { Clause } from "../text/segment";
import type { DocKind, StoredMatch, StoredSegment } from "../types";
import type { QuoteMatch, VerifiableDoc } from "../verify/quote";

/** Everything about a ready document that answering and verifying need, loaded once and cached. */
export interface LoadedDocument {
  id: string;
  name: string;
  kind: DocKind;
  pageCount: number | null;
  chunkCount: number;
  unreadablePages: number[];
  pages: Segment[];
  clauses: Clause[];
  verifiable: VerifiableDoc;
}

const CACHE_SIZE = 8;
const globals = globalThis as unknown as { __contractsDocCache?: Map<string, LoadedDocument> };
const cache = (globals.__contractsDocCache ??= new Map());

export function forgetDocument(id: string): void {
  cache.delete(id);
}

export async function loadDocument(id: string): Promise<LoadedDocument | null> {
  const hit = cache.get(id);
  if (hit) {
    // Re-insert so the least recently used entry is the first key.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }

  const { documents, documentContent } = schema;
  const [row] = await db()
    .select({
      id: documents.id,
      name: documents.name,
      kind: documents.kind,
      status: documents.status,
      pageCount: documents.pageCount,
      chunkCount: documents.chunkCount,
      unreadablePages: documents.unreadablePages,
      text: documentContent.text,
      key: documentContent.key,
      keyMap: documentContent.keyMap,
      pages: documentContent.pages,
      boilerplate: documentContent.boilerplate,
      clauses: documentContent.clauses,
    })
    .from(documents)
    .innerJoin(documentContent, eq(documentContent.documentId, documents.id))
    .where(eq(documents.id, id));

  if (!row || row.status !== "ready" || row.text === null || row.key === null || !row.keyMap) return null;

  // Copy out of the driver's buffer: its byte offset isn't guaranteed to be 4-byte aligned.
  const bytes = new Uint8Array(row.keyMap);
  const map = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

  const loaded: LoadedDocument = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    unreadablePages: row.unreadablePages,
    pages: row.pages ?? [],
    clauses: row.clauses ?? [],
    verifiable: { text: row.text, key: row.key, map, boilerplate: row.boilerplate ?? [] },
  };
  cache.set(id, loaded);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return loaded;
}

/** 1-based page containing `offset`, or null when the document has no pages. */
export function pageAt(pages: Segment[], offset: number): number | null {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < pages[mid].start) hi = mid - 1;
    else if (offset >= pages[mid].end) lo = mid + 1;
    else return mid + 1;
  }
  // In the gap between two pages: belongs with the page that follows.
  return pages.length && lo < pages.length ? lo + 1 : pages.length || null;
}


export function toStoredMatch(match: QuoteMatch, pages: Segment[], text: string): StoredMatch {
  const segments: StoredSegment[] = [];
  for (const segment of match.segments) {
    if (!pages.length) {
      segments.push({ start: segment.start, end: segment.end, page: null, pageStart: 0 });
      continue;
    }
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (page.end <= segment.start) continue;
      if (page.start >= segment.end) break;
      let start = Math.max(segment.start, page.start);
      let end = Math.min(segment.end, page.end);
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (start < end) segments.push({ start, end, page: i + 1, pageStart: page.start });
    }
  }
  return { start: match.start, end: match.end, segments };
}
