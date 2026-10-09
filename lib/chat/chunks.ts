import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";

/**
 * Access to a document's chunk index. Answering goes through this interface, so
 * the pipeline doesn't depend on where the index is stored.
 */

export interface ChunkRow {
  documentId: string;
  ordinal: number;
  section: string;
  heading: string;
  start: number;
  end: number;
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
}

export interface RankedChunk extends ChunkRow {
  rank: number;
}

export interface ChunkStore {
  /** Best-matching chunks for a natural-language query, searching the whole document (PRD A4.2). */
  search(documentId: string, query: string, limit: number): Promise<RankedChunk[]>;
  /** Every chunk in document order. */
  all(documentId: string): Promise<ChunkRow[]>;
}

/**
 * Words a question uses are often not the words a contract uses. These add the
 * contract's usual vocabulary to the search without another model call.
 */
const EXPANSIONS: [RegExp, string][] = [
  [/\b(cap|capped|limit(ed|s)? of liability|liability (cap|limit)|maximum liability)\b/i, "limitation liability aggregate exceed maximum liable"],
  [/\bnotice period|how much notice|days'? notice\b/i, "notice days written prior terminate"],
  [/\bgoverning law|which law|jurisdiction\b/i, "governed governing laws jurisdiction courts construed"],
  [/\bterminat(e|ion|ing)|end the (contract|agreement)|cancel\b/i, "terminate termination expiry convenience breach"],
  [/\b(payment|pay|fees?|price|charges?|invoice)\b/i, "fees payment invoice charges payable"],
  [/\bconfidential/i, "confidential confidentiality disclose disclosure"],
  [/\bindemn/i, "indemnify indemnity indemnification hold harmless losses"],
  [/\brenew/i, "renewal renew term extend extension"],
  [/\bassign/i, "assignment assign transfer novate subcontract"],
  [/\bnon-?compete|compete\b/i, "compete competing competition restraint restrictive covenant solicit"],
  [/\bdispute|arbitrat/i, "dispute arbitration courts mediation resolution"],
  [/\bterm\b|\bduration\b|how long/i, "term period years commencement effective date expire"],
  [/\bforce majeure|beyond (its|their) control/i, "force majeure beyond reasonable control"],
  [/\b(ip|intellectual property|ownership)\b/i, "intellectual property rights ownership licence license"],
  [/\bwarrant/i, "warranty warranties warrants represents"],
  [/\binsurance\b/i, "insurance insured policy cover"],
  [/\bpenalt|liquidated|late (payment|delivery)/i, "liquidated damages penalty interest late delay"],
];

export function expandQuery(query: string): string {
  const extra = EXPANSIONS.filter(([pattern]) => pattern.test(query)).map(([, words]) => words);
  return extra.length ? `${query} ${extra.join(" ")}` : query;
}

const columns = {
  documentId: schema.chunks.documentId,
  ordinal: schema.chunks.ordinal,
  section: schema.chunks.section,
  heading: schema.chunks.heading,
  start: schema.chunks.startOffset,
  end: schema.chunks.endOffset,
  pageFrom: schema.chunks.pageFrom,
  pageTo: schema.chunks.pageTo,
  text: schema.chunks.text,
};

interface TermStats {
  /** Chunks in the document when the stats were taken; a change means the document was re-processed. */
  total: number;
  /** For each lexeme, the number of chunks containing it. */
  chunksWith: Map<string, number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const globals = globalThis as unknown as { __contractsTermStats?: Map<string, TermStats> };
const statsCache = (globals.__contractsTermStats ??= new Map());

async function termStats(documentId: string): Promise<TermStats> {
  const counted = await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM chunks WHERE document_id = ${documentId}`);
  const total = counted.rows[0]?.n ?? 0;
  const hit = statsCache.get(documentId);
  if (hit && hit.total === total) return hit;

  // ts_stat takes its query as text, so the id is checked before it goes in.
  if (!UUID.test(documentId)) throw new Error(`Invalid document id ${documentId}`);
  const rows = await db().execute<{ word: string; ndoc: number }>(
    sql.raw(`SELECT word, ndoc FROM ts_stat('SELECT tsv FROM chunks WHERE document_id = ''${documentId}''')`),
  );
  const stats: TermStats = { total, chunksWith: new Map(rows.rows.map((r) => [r.word, Number(r.ndoc)])) };
  statsCache.set(documentId, stats);
  if (statsCache.size > 32) statsCache.delete(statsCache.keys().next().value!);
  return stats;
}

async function lexemes(text: string): Promise<string[]> {
  const rows = await db().execute<{ l: string }>(sql`SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', ${text}))) AS l`);
  return rows.rows.map((r) => r.l);
}

/** Share of chunks a word may appear in and still help find the right place. */
const COMMON_SHARE = 0.6;
/** Synonyms added by expandQuery count for less than the words actually asked. */
const EXPANSION_WEIGHT = 0.5;

export const postgresChunks: ChunkStore = {
  /**
   * Keyword search weighted by how rare each word is in this document (IDF).
   * Postgres's own ranking counts how often a word occurs but not how rare it
   * is, so in a credit agreement every chunk full of "Borrower" would outrank
   * the one chunk that mentions "immunity". A word in most of the document is
   * dropped; the rest score log(1 + chunks / chunks containing the word).
   */
  async search(documentId, query, limit) {
    const [asked, expanded, stats] = await Promise.all([lexemes(query), lexemes(expandQuery(query)), termStats(documentId)]);
    const askedSet = new Set(asked);
    let terms = expanded
      .filter((l) => stats.chunksWith.has(l))
      .map((l) => {
        const n = stats.chunksWith.get(l)!;
        return { l, n, weight: Math.log(1 + stats.total / n) * (askedSet.has(l) ? 1 : EXPANSION_WEIGHT) };
      });
    if (!terms.length) return [];
    const telling = terms.filter((t) => t.n <= Math.max(2, stats.total * COMMON_SHARE));
    if (telling.length) terms = telling;

    const score = sql.join(
      terms.map((t) => sql`CASE WHEN ${schema.chunks.tsv} @@ quote_literal(${t.l})::tsquery THEN ${t.weight}::float8 ELSE 0.0 END`),
      sql` + `,
    );
    const rank = sql<number>`(${score})`;
    return db()
      .select({ ...columns, rank })
      .from(schema.chunks)
      .where(sql`${schema.chunks.documentId} = ${documentId} AND (${score}) > 0`)
      .orderBy(sql`${rank} DESC`, asc(schema.chunks.ordinal))
      .limit(limit);
  },

  async all(documentId) {
    return db().select(columns).from(schema.chunks).where(eq(schema.chunks.documentId, documentId)).orderBy(asc(schema.chunks.ordinal));
  },
};
