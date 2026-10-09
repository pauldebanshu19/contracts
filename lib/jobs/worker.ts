import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { jobsRunInRequests } from "../config";
import { db, ensureMigrated, schema } from "../db";
import type { JobType } from "../db/schema";
import { requestDeadline } from "../deadline";

const { jobs } = schema;

const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
const STALE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 2;
/** On a host with a time limit, a job isn't started with less than this left: it would only be cut off. */
const MIN_START_MS = 30_000;
/** How often an ordinary request looks for jobs that an earlier, cut-off request left behind. */
const SWEEP_MS = 5000;

type Handler = (targetId: string, heartbeat: () => Promise<void>, deadline?: number) => Promise<void>;
type FailureHandler = (targetId: string, error: unknown) => Promise<void>;

// Imported lazily so the worker module stays light for routes that only enqueue.
const handlers: Record<JobType, { run: Handler; fail: FailureHandler }> = {
  ingest: {
    run: async (id, heartbeat) => (await import("../ingest/process")).ingestDocument(id, heartbeat),
    fail: async (id, error) => (await import("../ingest/process")).failDocument(id, error),
  },
  compare: {
    run: async (id, heartbeat, deadline) => (await import("../compare/run")).runComparison(id, heartbeat, deadline),
    fail: async (id, error) => (await import("../compare/run")).failComparison(id, error),
  },
};

interface WorkerState {
  started: boolean;
  running: number;
  timer?: ReturnType<typeof setInterval>;
  tick?: () => void;
  /** Request mode: when this process last looked for leftover jobs. */
  swept?: number;
}

const globals = globalThis as unknown as { __contractsWorker?: WorkerState };
const state = (globals.__contractsWorker ??= { started: false, running: 0 });

/**
 * `all` is used once at start: this app is a single process, so any job still
 * marked running then belonged to a process that is gone.
 */
async function requeueStale(all = false): Promise<void> {
  const cutoff = new Date(all ? Date.now() + STALE_MS : Date.now() - STALE_MS);
  const stale = and(eq(jobs.status, "running"), or(isNull(jobs.heartbeatAt), lt(jobs.heartbeatAt, cutoff)));

  const abandoned = await db()
    .update(jobs)
    .set({ status: "failed", error: "Interrupted too many times." })
    .where(and(stale, sql`${jobs.attempts} >= ${MAX_ATTEMPTS}`))
    .returning();
  for (const job of abandoned) {
    await handlers[job.type].fail(job.targetId, new Error("interrupted")).catch(() => {});
  }
  await db().update(jobs).set({ status: "queued" }).where(stale);
}

async function claim() {
  const result = await db().execute<{ id: string; type: JobType; target_id: string }>(sql`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, heartbeat_at = now()
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'queued'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, target_id
  `);
  return result.rows[0];
}

async function runOne(job: { id: string; type: JobType; target_id: string }, deadline?: number): Promise<void> {
  const heartbeat = async () => {
    await db().update(jobs).set({ heartbeatAt: new Date() }).where(eq(jobs.id, job.id));
  };
  // Keeps the job alive through long steps that can't report progress themselves.
  const pulse = setInterval(() => void heartbeat().catch(() => {}), HEARTBEAT_MS);
  try {
    await handlers[job.type].run(job.target_id, heartbeat, deadline);
    await db().update(jobs).set({ status: "done", error: null }).where(eq(jobs.id, job.id));
  } catch (error) {
    // A file we can't read is an expected outcome, not a server fault: one line is enough.
    if (error instanceof Error && error.name === "IngestError" && (error as { code?: string }).code !== "internal") {
      console.info(`[jobs] ${job.type} ${job.target_id}: ${error.message}`);
    } else {
      console.error(`[jobs] ${job.type} ${job.target_id} failed:`, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    await db().update(jobs).set({ status: "failed", error: message }).where(eq(jobs.id, job.id));
    await handlers[job.type].fail(job.target_id, error).catch((e) => console.error("[jobs] fail handler:", e));
  } finally {
    clearInterval(pulse);
  }
}

async function drain(): Promise<void> {
  while (state.running < CONCURRENCY) {
    const job = await claim();
    if (!job) return;
    state.running++;
    void runOne(job).finally(() => {
      state.running--;
      void drain().catch((e) => console.error("[jobs] drain:", e));
    });
  }
}

/**
 * Runs queued jobs until none are left. This is how jobs run on a host with no long-lived
 * process: it is scheduled with `after`, which keeps the request's function alive until it returns.
 */
async function runQueued(deadline?: number): Promise<void> {
  await ensureMigrated();
  // A job whose request was cut off stops sending heartbeats; it goes back in the queue here.
  await requeueStale();
  const inFlight = new Set<Promise<void>>();
  for (;;) {
    while (inFlight.size < CONCURRENCY) {
      if (deadline && deadline - Date.now() < MIN_START_MS) break;
      const job = await claim();
      if (!job) break;
      const running: Promise<void> = runOne(job, deadline).finally(() => inFlight.delete(running));
      inFlight.add(running);
    }
    if (!inFlight.size) return;
    await Promise.race(inFlight);
  }
}

function runQueuedAfterResponse(): void {
  // Read now: the deadline belongs to the request being handled.
  const deadline = requestDeadline();
  after(() => runQueued(deadline).catch((e) => console.error("[jobs] run:", e)));
}

/**
 * Called by every request. With a worker loop it makes sure the loop is running. Without one,
 * every few seconds a request also looks for leftover jobs, so the page polling for progress is
 * what gets an interrupted job going again.
 */
export function keepJobsMoving(): void {
  if (!jobsRunInRequests()) return startWorker();
  if (Date.now() - (state.swept ?? 0) < SWEEP_MS) return;
  state.swept = Date.now();
  runQueuedAfterResponse();
}

/** Starts the worker loop once per process. Does nothing where jobs run in requests instead. */
export function startWorker(): void {
  if (jobsRunInRequests() || state.started) return;
  state.started = true;

  let sweep = 0;
  const tick = () => {
    void (async () => {
      await ensureMigrated();
      // Stale jobs are checked at start (recovery after a restart) and every 30 s after.
      if (sweep % 15 === 0) await requeueStale(sweep === 0);
      sweep++;
      await drain();
    })().catch((e) => console.error("[jobs] tick:", e));
  };
  state.tick = tick;
  state.timer = setInterval(tick, POLL_MS);
  state.timer.unref?.();
  tick();
}

export async function enqueue(type: JobType, targetId: string): Promise<void> {
  await db().insert(jobs).values({ type, targetId });
  if (jobsRunInRequests()) {
    state.swept = Date.now();
    runQueuedAfterResponse();
    return;
  }
  startWorker();
  state.tick?.();
}
