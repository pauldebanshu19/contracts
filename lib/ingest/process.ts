import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { detectBoilerplate } from "../text/boilerplate";
import { normalizeWithMap, type Segment } from "../text/normalize";
import { buildChunks, pagesOf, segmentClauses, type LineHint } from "../text/segment";
import { extractDocx } from "./docx";
import { IngestError, NEEDS_OCR_MESSAGE } from "./errors";
import { extractPdf } from "./pdf";

/**
 * The ingestion job (PRD A1.3 to A1.7): extract text, build the normalised key
 * and the chunk index, and only then mark the document ready. Any failure
 * leaves a specific message on the document; nothing is ever marked ready with
 * no text behind it.
 */

const { documents, documentContent, chunks } = schema;

async function setProgress(documentId: string, done: number, total: number) {
  await db().update(documents).set({ progressDone: done, progressTotal: total }).where(eq(documents.id, documentId));
}

export async function ingestDocument(documentId: string, heartbeat: () => Promise<void>): Promise<void> {
  const [doc] = await db().select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return; // deleted while queued
  const [content] = await db()
    .select({ file: documentContent.file })
    .from(documentContent)
    .where(eq(documentContent.documentId, documentId));
  if (!content) throw new IngestError("internal", "The uploaded file is missing. Upload it again.");

  await db()
    .update(documents)
    .set({ status: "processing", stage: "extracting", progressDone: 0, progressTotal: 0, errorCode: null, errorMessage: null })
    .where(eq(documents.id, documentId));

  const bytes = new Uint8Array(content.file);
  let text: string;
  let pages: Segment[] = [];
  let itemCounts: number[] = [];
  let unreadablePages: number[] = [];
  let html: string | null = null;
  let hints: LineHint[] = [];

  if (doc.kind === "pdf") {
    let lastWrite = 0;
    const extraction = await extractPdf(bytes, async (page, total) => {
      // Progress is written at most a few times a second; every page would be wasteful.
      const now = Date.now();
      if (page === total || now - lastWrite > 250) {
        lastWrite = now;
        await setProgress(documentId, page, total);
        await heartbeat();
      }
    });
    ({ text, pages, itemCounts, unreadablePages } = extraction);

    // "Most pages have almost no text" means a scan (A1.5).
    if (pages.length === 0 || unreadablePages.length > pages.length / 2) {
      throw new IngestError("needs_ocr", NEEDS_OCR_MESSAGE);
    }
  } else {
    const extraction = await extractDocx(bytes);
    ({ text, html, hints } = extraction);
    if (text.replace(/\s/g, "").length < 20) {
      throw new IngestError("empty", "This Word file has no text in it, so there is nothing to read.");
    }
  }

  await db().update(documents).set({ stage: "indexing", progressDone: 0, progressTotal: 0 }).where(eq(documents.id, documentId));
  await heartbeat();

  const { key, map } = normalizeWithMap(text);
  const boilerplate = detectBoilerplate(text, pages);
  const clauses = segmentClauses(text, hints);
  const built = buildChunks(text, clauses);

  await db().transaction(async (tx) => {
    await tx
      .update(documentContent)
      .set({
        text,
        html,
        key,
        keyMap: Buffer.from(map.buffer, map.byteOffset, map.byteLength),
        pages,
        itemCounts,
        boilerplate,
        clauses,
      })
      .where(eq(documentContent.documentId, documentId));

    await tx.delete(chunks).where(eq(chunks.documentId, documentId));
    for (let i = 0; i < built.length; i += 200) {
      await tx.insert(chunks).values(
        built.slice(i, i + 200).map((chunk) => {
          const range = pagesOf(chunk, pages);
          return {
            documentId,
            ordinal: chunk.ordinal,
            section: chunk.section,
            heading: chunk.heading,
            startOffset: chunk.start,
            endOffset: chunk.end,
            pageFrom: range?.from ?? null,
            pageTo: range?.to ?? null,
            text: chunk.text,
          };
        }),
      );
    }

    await tx
      .update(documents)
      .set({
        status: "ready",
        stage: null,
        pageCount: doc.kind === "pdf" ? pages.length : null,
        chunkCount: built.length,
        unreadablePages,
        progressDone: 0,
        progressTotal: 0,
      })
      .where(eq(documents.id, documentId));
  });
}

/** Record a failure on the document in words meant for the person who uploaded it. */
export async function failDocument(documentId: string, error: unknown): Promise<void> {
  const known = error instanceof IngestError ? error : null;
  await db()
    .update(documents)
    .set({
      status: known?.code === "needs_ocr" ? "needs_ocr" : "failed",
      stage: null,
      errorCode: known?.code ?? "internal",
      errorMessage: known?.message ?? "Something went wrong while processing this file. Try again.",
    })
    .where(eq(documents.id, documentId));
}
