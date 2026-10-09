import { inArray } from "drizzle-orm";
import { z } from "zod";
import { MAX_DOCS_PER_CHAT } from "@/lib/config";
import { db, schema } from "@/lib/db";
import { jsonError, ready } from "@/lib/http";

const body = z.object({
  documentIds: z.array(z.uuid()).min(1).max(MAX_DOCS_PER_CHAT),
});


export async function POST(request: Request) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, `Choose between 1 and ${MAX_DOCS_PER_CHAT} documents.`);
  const ids = [...new Set(parsed.data.documentIds)];

  const docs = await db()
    .select({ id: schema.documents.id, name: schema.documents.name, status: schema.documents.status })
    .from(schema.documents)
    .where(inArray(schema.documents.id, ids));
  if (docs.length !== ids.length) return jsonError(404, "One of the documents no longer exists.");
  const notReady = docs.find((d) => d.status !== "ready");
  if (notReady) return jsonError(409, `"${notReady.name}" isn't ready yet, so it can't be asked about.`);

  const title = ids.length === 1 ? "New chat" : `Across ${ids.length} documents`;
  const chatId = await db().transaction(async (tx) => {
    const [chat] = await tx.insert(schema.chats).values({ title }).returning({ id: schema.chats.id });
    // Aliases follow the order the documents were selected in.
    await tx.insert(schema.chatDocuments).values(ids.map((documentId, i) => ({ chatId: chat.id, documentId, alias: `D${i + 1}`, position: i })));
    return chat.id;
  });
  return Response.json({ id: chatId }, { status: 201 });
}
