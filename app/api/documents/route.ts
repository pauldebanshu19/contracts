import { createHash } from "node:crypto";
import { count } from "drizzle-orm";
import { config } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { listDocuments } from "@/lib/documents/queries";
import { sniff } from "@/lib/ingest/sniff";
import { jsonError, rateLimited, ready } from "@/lib/http";
import { enqueue } from "@/lib/jobs/worker";

export async function GET() {
  await ready();
  return Response.json({ documents: await listDocuments() });
}

/** Upload (PRD A1.1, A1.2): checked by extension, signature and size, then queued for processing. */
export async function POST(request: Request) {
  await ready();
  const c = config();
  const limited = rateLimited(request, "upload", c.RATE_LIMIT_UPLOADS_PER_HOUR);
  if (limited) return limited;

  // Reject an oversized body before reading it, when the size is declared.
  const declared = Number(request.headers.get("content-length") ?? 0);
  const maxBytes = c.MAX_UPLOAD_MB * 1024 * 1024;
  if (declared > maxBytes + 64 * 1024) return jsonError(413, `This file is larger than ${c.MAX_UPLOAD_MB} MB.`);

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    file = value instanceof File ? value : null;
  } catch {
    return jsonError(400, "The upload didn't arrive complete. Try again.");
  }
  if (!file) return jsonError(400, "No file was attached.");
  if (file.size > maxBytes) return jsonError(413, `This file is larger than ${c.MAX_UPLOAD_MB} MB.`);
  if (file.size === 0) return jsonError(400, "This file is empty.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(file.name, bytes);
  if (!kind.ok) return jsonError(415, kind.message, { code: kind.code });

  const [{ value: stored }] = await db().select({ value: count() }).from(schema.documents);
  if (stored >= c.MAX_DOCUMENTS) {
    return jsonError(409, `The library is full (${c.MAX_DOCUMENTS} documents). Delete one to upload another.`);
  }

  const name = file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || `document.${kind.kind}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = await db().transaction(async (tx) => {
    const [doc] = await tx
      .insert(schema.documents)
      .values({ name, kind: kind.kind, size: file.size, sha256, status: "processing", stage: "extracting" })
      .returning({ id: schema.documents.id });
    await tx.insert(schema.documentContent).values({ documentId: doc.id, file: Buffer.from(bytes) });
    return doc.id;
  });
  await enqueue("ingest", id);

  const document = (await listDocuments()).find((d) => d.id === id);
  return Response.json({ document }, { status: 201 });
}
