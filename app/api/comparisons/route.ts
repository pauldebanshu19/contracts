import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { jsonError, ready } from "@/lib/http";
import { enqueue } from "@/lib/jobs/worker";

const body = z.object({ a: z.uuid(), b: z.uuid() });

export async function POST(request: Request) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.a === parsed.data.b) return jsonError(400, "Choose two different documents to compare.");
  const { a, b } = parsed.data;

  const docs = await db()
    .select({ id: schema.documents.id, name: schema.documents.name, status: schema.documents.status })
    .from(schema.documents)
    .where(inArray(schema.documents.id, [a, b]));
  if (docs.length !== 2) return jsonError(404, "One of the documents no longer exists.");
  const notReady = docs.find((d) => d.status !== "ready");
  if (notReady) return jsonError(409, `"${notReady.name}" isn't ready yet.`);

  // Comparing the same pair again opens the existing comparison.
  const [existing] = await db()
    .select({ id: schema.comparisons.id, status: schema.comparisons.status })
    .from(schema.comparisons)
    .where(and(eq(schema.comparisons.docA, a), eq(schema.comparisons.docB, b)));
  if (existing && existing.status !== "failed") return Response.json({ id: existing.id });

  const [row] = existing
    ? await db().update(schema.comparisons).set({ status: "processing", error: null }).where(eq(schema.comparisons.id, existing.id)).returning({ id: schema.comparisons.id })
    : await db().insert(schema.comparisons).values({ docA: a, docB: b, stage: "Queued" }).returning({ id: schema.comparisons.id });
  await enqueue("compare", row.id);
  return Response.json({ id: row.id }, { status: 201 });
}
