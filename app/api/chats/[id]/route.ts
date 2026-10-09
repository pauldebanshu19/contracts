import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { loadChat } from "@/lib/chat/store";
import { UUID, jsonError, ready } from "@/lib/http";

export async function GET(_request: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Chat not found.");
  const chat = await loadChat(id);
  return chat ? Response.json({ chat }) : jsonError(404, "Chat not found.");
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/chats/[id]">) {
  const unavailable = await ready();
  if (unavailable) return unavailable;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, "Chat not found.");
  await db().delete(schema.chats).where(eq(schema.chats.id, id));
  return Response.json({ ok: true });
}
