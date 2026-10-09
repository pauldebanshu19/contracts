import { connection } from "next/server";
import { ensureMigrated } from "./db";
import { startWorker } from "./jobs/worker";

/** Small helpers shared by the route handlers. */

export function jsonError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status });
}

/**
 * Every handler starts here: it waits for a real request (so nothing is
 * prerendered at build time), makes sure the schema is current, and makes sure
 * the job worker is running in this process.
 */
export async function ready(): Promise<void> {
  await connection();
  await ensureMigrated();
  startWorker();
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0].trim() || request.headers.get("x-real-ip") || "local";
}


const globals = globalThis as unknown as { __contractsRate?: Map<string, number[]> };
const hits: Map<string, number[]> = (globals.__contractsRate ??= new Map());

export function rateLimited(request: Request, bucket: string, perHour: number): Response | null {
  const key = `${bucket}:${clientIp(request)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= perHour) {
    const retry = Math.ceil((recent[0] + 3_600_000 - now) / 60_000);
    hits.set(key, recent);
    return jsonError(429, `Too many requests. Try again in about ${retry} minute${retry === 1 ? "" : "s"}.`);
  }
  recent.push(now);
  hits.set(key, recent);
  return null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
