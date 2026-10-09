import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { UUID, jsonError, ready } from "@/lib/http";

const MAX_CLAUSE_CHARS = 20_000;

async function docSummary(id: string) {
  const [row] = await db()
    .select({ id: schema.documents.id, name: schema.documents.name, kind: schema.documents.kind, text: schema.documentContent.text })
    .from(schema.documents)
    .innerJoin(schema.documentContent, eq(schema.documentContent.documentId, schema.documents.id))
    .where(eq(schema.documents.id, id));
  return row;
}

/** A comparison with its changes and, for each change, the text of both clauses (PRD B3.6–B3.8). */
export async function GET(_request: Request, ctx: RouteContext<"/api/comparisons/[id]">) {
  await ready();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Comparison not found.");

  const [comparison] = await db().select().from(schema.comparisons).where(eq(schema.comparisons.id, id));
  if (!comparison) return jsonError(404, "Comparison not found.");
  const [a, b] = await Promise.all([docSummary(comparison.docA), docSummary(comparison.docB)]);

  const rows =
    comparison.status === "ready"
      ? await db().select().from(schema.comparisonChanges).where(eq(schema.comparisonChanges.comparisonId, id)).orderBy(asc(schema.comparisonChanges.ordinal))
      : [];
  const slice = (text: string | null | undefined, start: number | null, end: number | null) =>
    text && start !== null && end !== null ? text.slice(start, Math.min(end, start + MAX_CLAUSE_CHARS)).trim() : null;

  return Response.json({
    comparison: {
      id: comparison.id,
      status: comparison.status,
      stage: comparison.stage,
      summary: comparison.summary ?? [],
      notice: comparison.notice,
      error: comparison.error,
      a: { id: a?.id, name: a?.name, kind: a?.kind },
      b: { id: b?.id, name: b?.name, kind: b?.kind },
      changes: rows.map((row) => ({
        id: row.id,
        ordinal: row.ordinal,
        type: row.type,
        significance: row.significance,
        floor: row.floor,
        floorReasons: row.floorReasons,
        category: row.category,
        summary: row.summary,
        a: row.aStart !== null ? { number: row.aNumber, heading: row.aHeading, start: row.aStart, end: row.aEnd, text: slice(a?.text, row.aStart, row.aEnd) } : null,
        b: row.bStart !== null ? { number: row.bNumber, heading: row.bHeading, start: row.bStart, end: row.bEnd, text: slice(b?.text, row.bStart, row.bEnd) } : null,
      })),
    },
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/comparisons/[id]">) {
  await ready();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Comparison not found.");
  await db().delete(schema.comparisons).where(eq(schema.comparisons.id, id));
  return Response.json({ ok: true });
}
