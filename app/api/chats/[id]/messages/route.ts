import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { answerQuestion } from "@/lib/chat/answer";
import { postgresChunks } from "@/lib/chat/chunks";
import type { AnswerDoc } from "@/lib/chat/run";
import { activeAnswers, chatDocumentsOf, databaseSink, recentHistory } from "@/lib/chat/store";
import { AnswerWriter } from "@/lib/chat/writer";
import { config, llmConfigured } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { loadDocument } from "@/lib/documents/content";
import { UUID, jsonError, rateLimited, ready } from "@/lib/http";
import { getLlm } from "@/lib/llm/openai";
import type { StreamEvent } from "@/lib/types";

const body = z.object({
  question: z.string().trim().min(1).max(4000),
  research: z.boolean().optional().default(true),
});

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;

/**
 * Ask a question; the answer streams back as Server-Sent Events (PRD A2.1).
 *
 * The assistant message is created before the first token and saved as it
 * grows (A2.3). If the browser goes away, by Stop, Esc, reload or closing the
 * tab, the request is aborted and what was written so far is saved with
 * status "stopped" (A2.2).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/chats/[id]/messages">) {
  await ready();
  const { id: chatId } = await ctx.params;
  if (!UUID.test(chatId)) return jsonError(404, "Chat not found.");

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Type a question first.");
  const limited = rateLimited(request, "question", config().RATE_LIMIT_QUESTIONS_PER_HOUR);
  if (limited) return limited;
  if (!llmConfigured()) {
    return jsonError(503, "No model is configured on the server. Set LLM_API_KEY and LLM_MODEL, then restart.");
  }

  const [chat] = await db().select().from(schema.chats).where(eq(schema.chats.id, chatId));
  if (!chat) return jsonError(404, "Chat not found.");
  const busy = await db()
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chatId), eq(schema.messages.status, "streaming")));
  if (busy.some((m) => activeAnswers.has(m.id))) return jsonError(409, "An answer is still being written in this chat.");

  const links = await chatDocumentsOf(chatId);
  const docs: AnswerDoc[] = [];
  for (const link of links) {
    const loaded = await loadDocument(link.id);
    if (!loaded) return jsonError(409, `"${link.name}" isn't available to read right now.`);
    docs.push({ id: link.id, alias: link.alias, name: link.name, loaded });
  }
  if (!docs.length) return jsonError(409, "This chat's documents were deleted.");

  const history = await recentHistory(chatId);
  const { question, research } = parsed.data;
  const { userId, assistantId } = await db().transaction(async (tx) => {
    const [user] = await tx.insert(schema.messages).values({ chatId, role: "user", content: question }).returning({ id: schema.messages.id });
    const [assistant] = await tx
      .insert(schema.messages)
      .values({ chatId, role: "assistant", content: "", status: "streaming" })
      .returning({ id: schema.messages.id });
    const title = chat.title === "New chat" ? question.replace(/\s+/g, " ").slice(0, 80) : chat.title;
    await tx.update(schema.chats).set({ title, updatedAt: new Date() }).where(eq(schema.chats.id, chatId));
    return { userId: user.id, assistantId: assistant.id };
  });
  activeAnswers.add(assistantId);

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          open = false;
        }
      };
      const emit = (event: StreamEvent) => send(`data: ${JSON.stringify(event)}\n\n`);
      // Keeps proxies from closing the connection during a long full scan.
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      emit({ type: "start", userMessageId: userId, assistantMessageId: assistantId });
      const writer = new AnswerWriter(databaseSink(assistantId, chatId, emit));

      void answerQuestion({
        docs,
        question,
        history,
        llm: getLlm(),
        chunks: postgresChunks,
        writer,
        signal: abort.signal,
        research,
      })
        .catch((error) => console.error("[chat] unexpected:", error))
        .finally(() => {
          clearInterval(heartbeat);
          activeAnswers.delete(assistantId);
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // already closed by the client
            }
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
