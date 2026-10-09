import { connection } from "next/server";
import { ensureMigrated } from "./db";
import { keepJobsMoving } from "./jobs/worker";

/** Small helpers shared by the route handlers. */

export function jsonError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status });
}

/** Every message in an error and its causes, including the per-address errors Node groups together. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const visit = (e: unknown, depth: number) => {
    if (!e || depth > 4) return;
    const err = e as { code?: string; message?: string; cause?: unknown; errors?: unknown[] };
    parts.push(`${err.code ?? ""} ${err.message ?? String(e)}`);
    for (const inner of err.errors ?? []) visit(inner, depth + 1);
    visit(err.cause, depth + 1);
  };
  visit(error, 0);
  return parts.join(" | ");
}

/** Why the database can't be used, in words for whoever is setting the app up. */
export function explainDatabaseError(error: unknown): string {
  // Without DATABASE_URL the server falls back to the local development database, so any
  // failure on a host that hasn't set it comes down to this.
  if (!process.env.DATABASE_URL?.trim()) {
    return "No database is configured. Set DATABASE_URL to a Postgres connection string in the host's environment variables and redeploy. (Running locally: start the database with npm run db:up.)";
  }
  const text = errorText(error);
  if (/ECONNREFUSED|ENOTFOUND|ENODATA|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timeout/i.test(text)) {
    // Supabase's direct host (db.<project>.supabase.co) has only an IPv6 address, which most hosts can't reach.
    if (/@db\.[a-z0-9]+\.supabase\.co/i.test(process.env.DATABASE_URL)) {
      return "The server can't reach the database: Supabase's direct connection works over IPv6 only. Use the Session pooler connection string from Supabase's Connect dialog in DATABASE_URL instead.";
    }
    return "The server can't reach its database. Check that DATABASE_URL points to a running Postgres that accepts connections from this host.";
  }
  if (/Tenant or user not found/i.test(text)) {
    return "The database pooler doesn't recognise this project. Copy the connection string again from the provider; with Supabase the user name is postgres.<project ref> and the host depends on the project's region.";
  }
  // This driver treats sslmode=require as full verification, which fails for providers that sign
  // their own certificates (Supabase among them). no-verify encrypts without that check.
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT_|self-signed certificate|unable to verify/i.test(text)) {
    return "The database's certificate couldn't be verified. Use ?sslmode=no-verify at the end of DATABASE_URL (the connection stays encrypted), or supply the provider's root certificate.";
  }
  // A server that insists on encryption uses the same error code as a refused login, so this comes first.
  if (/SSL|TLS|pg_hba|encryption/i.test(text)) {
    return "The database requires an encrypted connection. Add ?sslmode=no-verify to the end of DATABASE_URL.";
  }
  if (/28P01|28000|password authentication failed|role "[^"]*" does not exist/i.test(text)) {
    return "The database refused the login. Correct the user name and password in DATABASE_URL, then restart the server; it won't try again until then. (Characters such as @ : / # in a password must be percent-encoded.)";
  }
  if (/3D000|database "[^"]*" does not exist/i.test(text)) {
    return "The database named in DATABASE_URL doesn't exist on that server.";
  }
  if (/53300|max ?clients|too many (clients|connections)/i.test(text)) {
    return "The database has no free connections. On a serverless host, use the provider's transaction pooler connection string in DATABASE_URL.";
  }
  if (/_journal\.json|ENOENT/i.test(text)) {
    return "The database migration files (the drizzle folder) weren't deployed with the server, so its tables can't be created.";
  }
  if (/42501|permission denied/i.test(text)) {
    return "The database user isn't allowed to create tables. Use the database owner's credentials in DATABASE_URL.";
  }
  return "The server couldn't set up its database. The server log has the exact error.";
}

/**
 * Every handler starts here: it waits for a real request (so nothing is
 * prerendered at build time), makes sure the schema is current, and makes sure
 * queued jobs are being run. If the database can't be used it
 * returns the response to send instead: a 503 that says why.
 */
export async function ready(): Promise<Response | null> {
  await connection();
  try {
    await ensureMigrated();
  } catch (error) {
    console.error("[db] not ready:", error);
    return jsonError(503, explainDatabaseError(error), { code: "database_unavailable" });
  }
  keepJobsMoving();
  return null;
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
