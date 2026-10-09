import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { UUID, jsonError, ready } from "@/lib/http";


export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]/view">) {
  await ready();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Document not found.");

  const [row] = await db()
    .select({
      name: schema.documents.name,
      kind: schema.documents.kind,
      status: schema.documents.status,
      pageCount: schema.documents.pageCount,
      unreadablePages: schema.documents.unreadablePages,
      html: schema.documentContent.html,
      text: schema.documentContent.text,
      pages: schema.documentContent.pages,
      itemCounts: schema.documentContent.itemCounts,
    })
    .from(schema.documents)
    .innerJoin(schema.documentContent, eq(schema.documentContent.documentId, schema.documents.id))
    .where(eq(schema.documents.id, id));
  if (!row) return jsonError(404, "Document not found.");
  if (row.status !== "ready") return jsonError(409, "This document isn't ready yet.");

  return Response.json(
    {
      id,
      name: row.name,
      kind: row.kind,
      pageCount: row.pageCount,
      unreadablePages: row.unreadablePages,
      html: row.kind === "docx" ? row.html : null,
      textLength: row.text?.length ?? 0,
      pageLengths: (row.pages ?? []).map((p) => p.end - p.start),
      itemCounts: row.itemCounts ?? [],
    },
    { headers: { "Cache-Control": "private, max-age=3600" } },
  );
}
