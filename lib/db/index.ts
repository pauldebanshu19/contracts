import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

// Next can load this module more than once (route bundles, instrumentation,
// hot reload). One pool per process, kept on globalThis.
const globals = globalThis as unknown as { __contractsPool?: Pool; __contractsDb?: Db; __contractsMigrated?: Promise<void> };

export function pool(): Pool {
  globals.__contractsPool ??= new Pool({ connectionString: config().DATABASE_URL, max: 10 });
  return globals.__contractsPool;
}

export function db(): Db {
  globals.__contractsDb ??= drizzle(pool(), { schema });
  return globals.__contractsDb;
}

/** Applies pending migrations. Safe to call from several places; it runs once per process. */
export function ensureMigrated(): Promise<void> {
  globals.__contractsMigrated ??= migrate(db(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  }).catch((error) => {
    globals.__contractsMigrated = undefined;
    throw error;
  });
  return globals.__contractsMigrated;
}

export { schema };
