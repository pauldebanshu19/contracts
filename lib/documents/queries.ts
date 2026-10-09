import { asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { DocumentDTO } from "../types";

const { documents, chats, chatDocuments, comparisons } = schema;

const documentColumns = {
  id: documents.id,
  name: documents.name,
  kind: documents.kind,
  size: documents.size,
  status: documents.status,
  stage: documents.stage,
  progressDone: documents.progressDone,
  progressTotal: documents.progressTotal,
  pageCount: documents.pageCount,
  chunkCount: documents.chunkCount,
  unreadablePages: documents.unreadablePages,
  errorMessage: documents.errorMessage,
  createdAt: documents.createdAt,
};


export async function listDocuments(): Promise<DocumentDTO[]> {
  const rows = await db().select(documentColumns).from(documents).orderBy(desc(documents.createdAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const chatRows = await db()
    .select({
      documentId: chatDocuments.documentId,
      id: chats.id,
      title: chats.title,
      updatedAt: chats.updatedAt,
      documentCount: sql<number>`(SELECT count(*)::int FROM chat_documents cd WHERE cd.chat_id = ${chats.id})`,
    })
    .from(chatDocuments)
    .innerJoin(chats, eq(chats.id, chatDocuments.chatId))
    .where(inArray(chatDocuments.documentId, ids))
    .orderBy(desc(chats.updatedAt));

  const comparisonRows = await db()
    .select({ id: comparisons.id, docA: comparisons.docA, docB: comparisons.docB })
    .from(comparisons)
    .where(or(inArray(comparisons.docA, ids), inArray(comparisons.docB, ids)))
    .orderBy(asc(comparisons.createdAt));

  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    chats: chatRows
      .filter((c) => c.documentId === row.id)
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString(), documentCount: c.documentCount })),
    comparisons: comparisonRows
      .filter((c) => c.docA === row.id || c.docB === row.id)
      .map((c) => ({ id: c.id, otherName: names.get(c.docA === row.id ? c.docB : c.docA) ?? "another document" })),
  }));
}

/** What deleting a document also deletes, listed in the confirmation (A1.8). */
export async function dependentsOf(documentId: string) {
  const chatRows = await db()
    .select({ id: chats.id, title: chats.title })
    .from(chatDocuments)
    .innerJoin(chats, eq(chats.id, chatDocuments.chatId))
    .where(eq(chatDocuments.documentId, documentId));
  const comparisonRows = await db()
    .select({ id: comparisons.id })
    .from(comparisons)
    .where(or(eq(comparisons.docA, documentId), eq(comparisons.docB, documentId)));
  return { chats: chatRows, comparisons: comparisonRows.length };
}
