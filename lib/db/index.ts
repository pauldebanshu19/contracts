import net from "node:net";
import path from "node:path";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

// Next can load this module more than once (route bundles, instrumentation,
// hot reload). One pool per process, kept on globalThis.
const globals = globalThis as unknown as { __contractsPool?: Pool; __contractsDb?: Db; __contractsMigrated?: Promise<void> };

// Node tries each address of a host for 250 ms before moving to the next. Connecting to a database
// in another region takes longer than that, so every attempt would be abandoned and the connection
// would fail with ETIMEDOUT although the database is reachable.
const CONNECT_ATTEMPT_MS = 5000;

export function pool(): Pool {
  if (!globals.__contractsPool) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(Math.max(net.getDefaultAutoSelectFamilyAttemptTimeout(), CONNECT_ATTEMPT_MS));
    const created = new Pool({ connectionString: config().DATABASE_URL, max: 10 });
    // A hosted database or its pooler closes idle connections now and then. Without a listener
    // that would be an unhandled error and end the process; the pool replaces the connection itself.
    created.on("error", (error) => console.error("[db] idle connection dropped:", error.message));
    // Vercel suspends a function between requests. A connection left open across that is dead when
    // the function wakes; this closes idle ones first.
    if (process.env.VERCEL) attachDatabasePool(created);
    globals.__contractsPool = created;
  }
  return globals.__contractsPool;
}

export function db(): Db {
  globals.__contractsDb ??= drizzle(pool(), { schema });
  return globals.__contractsDb;
}

/** True when the database turned the user name or password down (Postgres codes 28P01 and 28000). */
function loginRefused(error: unknown): boolean {
  for (let e = error as { code?: string; cause?: unknown } | undefined, depth = 0; e && depth < 5; depth += 1) {
    if (e.code === "28P01" || e.code === "28000") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Applies pending migrations. Safe to call from several places; it runs once per process. */
export function ensureMigrated(): Promise<void> {
  globals.__contractsMigrated ??= migrate(db(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  }).catch((error) => {
    // A failed attempt is retried on the next call, except a refused login: that can't fix itself
    // without new settings and a restart, and hosted databases block an address after a couple of
    // wrong passwords (Supabase after two), so retrying on every request would lock the server out.
    if (!loginRefused(error)) globals.__contractsMigrated = undefined;
    throw error;
  });
  return globals.__contractsMigrated;
}

export { schema };
