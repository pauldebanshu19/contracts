import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import { CITE_MARKER, type ChatDTO, type CitationDTO, type MessageDTO } from "../types";
import type { AnswerSink, AnswerSnapshot } from "./writer";

/** Chats, messages and citations in Postgres. */

const { chats, chatDocuments, documents, messages, citations } = schema;

/** Answers being written by this process. A "streaming" message not in here was cut off by a restart. */
const globals = globalThis as unknown as { __contractsActive?: Set<string> };
export const activeAnswers = (globals.__contractsActive ??= new Set());

type CitationRow = typeof citations.$inferSelect;

function toCitationDTO(row: CitationRow): CitationDTO {
  const primary = row.matches[row.primaryMatch];
  return {
    ordinal: row.ordinal,
    documentId: row.documentId,
    alias: row.alias,
    verified: row.verified,
    reason: row.reason,
    reasonText: row.reasonText,
    displayText: row.displayText,
    matches: row.matches,
    primary: row.primaryMatch,
    page: primary?.segments[0]?.page ?? null,
  };
}

export async function chatDocumentsOf(chatId: string) {
  return db()
    .select({
      id: documents.id,
      alias: chatDocuments.alias,
      name: documents.name,
      kind: documents.kind,
      pageCount: documents.pageCount,
      status: documents.status,
    })
    .from(chatDocuments)
    .innerJoin(documents, eq(documents.id, chatDocuments.documentId))
    .where(eq(chatDocuments.chatId, chatId))
    .orderBy(asc(chatDocuments.position));
}

export async function loadChat(chatId: string): Promise<ChatDTO | null> {
  const [chat] = await db().select().from(chats).where(eq(chats.id, chatId));
  if (!chat) return null;
  const docs = await chatDocumentsOf(chatId);
  const rows = await db().select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt));
  const ids = rows.map((r) => r.id);
  const citeRows = ids.length
    ? await db().select().from(citations).where(inArray(citations.messageId, ids)).orderBy(asc(citations.ordinal))
    : [];

  const out: MessageDTO[] = rows.map((row) => {
    // Cut off by a restart: it will never finish, so it is shown as stopped.
    const orphaned = row.status === "streaming" && !activeAnswers.has(row.id);
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      status: orphaned ? "stopped" : row.status,
      mode: row.mode,
      answerStatus: row.answerStatus,
      coverage: row.coverage,
      steps: row.steps,
      error: row.error,
      citations: citeRows.filter((c) => c.messageId === row.id).map(toCitationDTO),
      createdAt: row.createdAt.toISOString(),
    };
  });

  return {
    id: chat.id,
    title: chat.title,
    documents: docs.map(({ id, alias, name, kind, pageCount }) => ({ id, alias, name, kind, pageCount })),
    messages: out,
  };
}


export async function recentHistory(chatId: string, limit = 6): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db()
    .select({ id: messages.id, role: messages.role, content: messages.content, status: messages.status, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), inArray(messages.status, ["complete", "stopped"])))
    .orderBy(asc(messages.createdAt));
  const recent = rows.slice(-limit);
  const ids = recent.filter((r) => r.role === "assistant").map((r) => r.id);
  const citeRows = ids.length ? await db().select().from(citations).where(inArray(citations.messageId, ids)) : [];

  return recent.map((row) => ({
    role: row.role,
    content: row.content.replace(CITE_MARKER, (_, n: string) => {
      const cite = citeRows.find((c) => c.messageId === row.id && c.ordinal === Number(n));
      return cite?.verified ? ` "${cite.displayText}"` : "";
    }),
  }));
}

/** Saves an answer as it grows. Citations are replaced wholesale: an answer has a few dozen at most. */
export function databaseSink(messageId: string, chatId: string, emit: AnswerSink["emit"]): AnswerSink {
  return {
    emit,
    async persist(snapshot: AnswerSnapshot) {
      await db().transaction(async (tx) => {
        await tx
          .update(messages)
          .set({
            content: snapshot.content,
            status: snapshot.status,
            mode: snapshot.mode,
            answerStatus: snapshot.answerStatus,
            coverage: snapshot.coverage,
            steps: snapshot.steps,
            error: snapshot.error,
          })
          .where(eq(messages.id, messageId));
        await tx.delete(citations).where(eq(citations.messageId, messageId));
        if (snapshot.citations.length) {
          await tx.insert(citations).values(
            snapshot.citations.map((c) => ({
              messageId,
              ordinal: c.ordinal,
              documentId: c.documentId,
              alias: c.alias,
              modelQuote: snapshot.modelQuotes[c.ordinal] ?? "",
              displayText: c.displayText,
              verified: c.verified,
              reason: c.reason,
              reasonText: c.reasonText,
              matches: c.matches,
              primaryMatch: c.primary,
            })),
          );
        }
        await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));
      });
    },
  };
}
