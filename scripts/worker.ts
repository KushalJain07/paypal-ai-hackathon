import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getRewindOrchestrator } from "../lib/rewind/composition.ts";
import type { PaymentOrchestrator } from "../orchestrator/service.ts";

type WorkerOrchestrator = Pick<
  PaymentOrchestrator,
  "recoverStaleReleases" | "releaseDue"
>;

export interface WorkerLogger {
  info(counts: {
    recoveredCaptured: number;
    recoveredFailed: number;
    captured: number;
    failed: number;
    skipped: number;
    errors: number;
  }): void;
  error(code: "WORKER_ITERATION_FAILED"): void;
}

export interface WorkerOptions {
  intervalMs: number;
  staleClaimSeconds: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  logger?: WorkerLogger;
}

const defaultLogger: WorkerLogger = {
  info: (counts) => console.log("REWIND_WORKER_COUNTS", counts),
  error: (code) => console.error("REWIND_WORKER_ERROR", { code }),
};

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runWorkerLoop(
  orchestrator: WorkerOrchestrator,
  signal: AbortSignal,
  options: WorkerOptions,
): Promise<void> {
  const intervalMs = z.number().int().positive().max(300000).parse(options.intervalMs);
  const staleClaimSeconds = z.number().int().positive().max(86400)
    .parse(options.staleClaimSeconds);
  const sleep = options.sleep ?? abortableSleep;
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());
  let consecutiveErrors = 0;

  while (!signal.aborted) {
    try {
      const currentTime = now();
      const recovered = await orchestrator.recoverStaleReleases(
        currentTime,
        staleClaimSeconds,
      );
      const results = await orchestrator.releaseDue(
        currentTime,
        staleClaimSeconds,
      );
      logger.info({
        recoveredCaptured: recovered.filter((item) => item.status === "captured")
          .length,
        recoveredFailed: recovered.filter((item) => item.status === "failed").length,
        captured: results.filter((item) => item.status === "captured").length,
        failed: results.filter((item) => item.status === "failed").length,
        skipped: results.filter((item) => item.status === "skipped").length +
          recovered.filter((item) => item.status === "skipped").length,
        errors: results.filter((item) => item.error !== undefined).length +
          recovered.filter((item) => item.error !== undefined).length,
      });
      consecutiveErrors = 0;
      await sleep(intervalMs, signal);
    } catch {
      logger.error("WORKER_ITERATION_FAILED");
      consecutiveErrors += 1;
      const backoffMs = Math.min(intervalMs * 2 ** (consecutiveErrors - 1), 60000);
      await sleep(backoffMs, signal);
    }
  }
}

function positiveEnv(name: string, defaultValue: number, maximum: number): number {
  return z.coerce.number().int().positive().max(maximum)
    .parse(process.env[name] ?? defaultValue);
}

export async function startWorker(): Promise<void> {
  const orchestrator = getRewindOrchestrator();
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runWorkerLoop(orchestrator, controller.signal, {
      intervalMs: positiveEnv("WORKER_INTERVAL_MS", 3000, 300000),
      staleClaimSeconds: positiveEnv("STALE_CLAIM_SECONDS", 120, 86400),
    });
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().catch(() => {
    console.error("REWIND_WORKER_ERROR", { code: "WORKER_START_FAILED" });
    process.exitCode = 1;
  });
}
