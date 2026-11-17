// Next.js server-start hook — runs exactly once when the server process boots (dev and prod).
// This is the right place to start Clara's durable in-process scheduler, rather than as a
// side effect of some random route handler being hit first.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/clara/scheduler");
    startScheduler();
  }
}
