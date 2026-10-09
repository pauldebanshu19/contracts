import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { forgetDocument } from "@/lib/documents/content";
import { listDocuments } from "@/lib/documents/queries";
import { UUID, jsonError, ready } from "@/lib/http";
import { enqueue } from "@/lib/jobs/worker";


export async function POST(_request: Request, ctx: RouteContext<"/api/documents/[id]/retry">) {
  await ready();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Document not found.");

  const [doc] = await db().select({ status: schema.documents.status }).from(schema.documents).where(eq(schema.documents.id, id));
  if (!doc) return jsonError(404, "Document not found.");
  if (doc.status === "processing") return jsonError(409, "This document is already being processed.");

  await db()
    .update(schema.documents)
    .set({ status: "processing", stage: "extracting", progressDone: 0, progressTotal: 0, errorCode: null, errorMessage: null })
    .where(eq(schema.documents.id, id));
  forgetDocument(id);
  await enqueue("ingest", id);
  return Response.json({ document: (await listDocuments()).find((d) => d.id === id) });
}
