import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWorkerLoop } from "../../scripts/worker.ts";

describe("release worker loop", () => {
  it("continues after errors with exponential backoff and stops on shutdown", async () => {
    const signal = new AbortController();
    const delays: number[] = [];
    const errors: string[] = [];
    let recoveryCalls = 0;
    const orchestrator = {
      recoverStaleReleases: async () => {
        recoveryCalls += 1;
        if (recoveryCalls < 3) {
          throw new Error("details are intentionally not logged");
        }
        return [];
      },
      releaseDue: async () => [],
    };

    await runWorkerLoop(orchestrator, signal.signal, {
      intervalMs: 100,
      staleClaimSeconds: 120,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 3) {
          signal.abort();
        }
      },
      logger: {
        info: () => {},
        error: (code) => errors.push(code),
      },
    });

    assert.equal(recoveryCalls, 3);
    assert.deepEqual(delays, [100, 200, 100]);
    assert.deepEqual(errors, [
      "WORKER_ITERATION_FAILED",
      "WORKER_ITERATION_FAILED",
    ]);
  });

  it("does not capture twice when two worker passes race", async () => {
    let claimHeld = false;
    let captureCount = 0;
    const orchestrator = {
      recoverStaleReleases: async () => [],
      releaseDue: async () => {
        await Promise.resolve();
        if (claimHeld) {
          return [{ paymentId: "payment-1", status: "skipped" as const }];
        }
        claimHeld = true;
        captureCount += 1;
        return [{ paymentId: "payment-1", status: "captured" as const }];
      },
    };
    const runOnce = async () => {
      const controller = new AbortController();
      await runWorkerLoop(orchestrator, controller.signal, {
        intervalMs: 100,
        staleClaimSeconds: 120,
        sleep: async () => controller.abort(),
        logger: { info: () => {}, error: () => {} },
      });
    };

    await Promise.all([runOnce(), runOnce()]);

    assert.equal(captureCount, 1);
  });
});
