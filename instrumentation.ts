export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureMigrated } = await import("./lib/db");
  const { startWorker } = await import("./lib/jobs/worker");
  try {
    await ensureMigrated();
    startWorker();
  } catch (error) {
    // The server still starts; each request retries the migration and reports what failed.
    console.error("[startup] database not ready:", error);
  }
}
