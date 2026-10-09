import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { UUID, jsonError, ready } from "@/lib/http";

/** The original file, for the PDF viewer and for download. */
export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]/file">) {
  await ready();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Document not found.");

  const [row] = await db()
    .select({ name: schema.documents.name, kind: schema.documents.kind, sha256: schema.documents.sha256, file: schema.documentContent.file })
    .from(schema.documents)
    .innerJoin(schema.documentContent, eq(schema.documentContent.documentId, schema.documents.id))
    .where(eq(schema.documents.id, id));
  if (!row) return jsonError(404, "Document not found.");

  const type = row.kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return new Response(new Uint8Array(row.file), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(row.file.length),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      // The bytes never change for a given document id.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${row.sha256}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
