import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { forgetDocument } from "@/lib/documents/content";
import { dependentsOf, listDocuments } from "@/lib/documents/queries";
import { UUID, jsonError, ready } from "@/lib/http";

export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Document not found.");
  const document = (await listDocuments()).find((d) => d.id === id);
  if (!document) return jsonError(404, "Document not found.");
  return Response.json({ document, dependents: await dependentsOf(id) });
}


export async function DELETE(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Document not found.");

  const deleted = await db().transaction(async (tx) => {
    const links = await tx
      .select({ chatId: schema.chatDocuments.chatId })
      .from(schema.chatDocuments)
      .where(eq(schema.chatDocuments.documentId, id));
    if (links.length) {
      await tx.delete(schema.chats).where(inArray(schema.chats.id, links.map((l) => l.chatId)));
    }
    await tx.delete(schema.jobs).where(eq(schema.jobs.targetId, id));
    // Comparisons, chunks, content and citations go with the document by cascade.
    const rows = await tx.delete(schema.documents).where(eq(schema.documents.id, id)).returning({ id: schema.documents.id });
    return rows.length > 0;
  });
  forgetDocument(id);
  if (!deleted) return jsonError(404, "Document not found.");
  return Response.json({ ok: true });
}
