/** Runs once when the server starts (Next.js instrumentation hook). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIngestWorker } = await import("./lib/ingest-queue");
    startIngestWorker();
  }
}
