// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { runWorkers, type WorkerSpec } from "./main";
import type { Worker } from "./core/worker";

// Adapt a plain run function into a Worker for the orchestration tests.
const asWorker = (run: (signal: AbortSignal) => Promise<void>): Worker => ({ run });

const noop = asWorker(async () => {
  // No-op for unused worker slots in a focused test case.
});

describe("runWorkers", () => {
  it("returns 0 when every worker completes normally", async () => {
    let tipRan = false;
    let subRan = false;
    let descRan = false;
    const specs: WorkerSpec[] = [
      {
        name: "tip",
        fatal: true,
        worker: asWorker(async () => {
          tipRan = true;
        }),
      },
      {
        name: "substrate",
        fatal: false,
        worker: asWorker(async () => {
          subRan = true;
        }),
      },
      {
        name: "descriptor",
        fatal: false,
        worker: asWorker(async () => {
          descRan = true;
        }),
      },
    ];
    const code = await runWorkers(specs);
    expect(code).toBe(0);
    expect(tipRan).toBe(true);
    expect(subRan).toBe(true);
    expect(descRan).toBe(true);
  });

  it("returns 1 when a fatal worker throws", async () => {
    const code = await runWorkers([
      {
        name: "tip",
        fatal: true,
        worker: asWorker(async () => {
          throw new Error("boom");
        }),
      },
      { name: "substrate", fatal: false, worker: noop },
      { name: "descriptor", fatal: false, worker: noop },
    ]);
    expect(code).toBe(1);
  });

  it("aborts the siblings when a fatal worker throws", async () => {
    const subAborted = { value: false };
    const code = await runWorkers([
      {
        name: "tip",
        fatal: true,
        worker: asWorker(async () => {
          throw new Error("tip blew up");
        }),
      },
      {
        name: "substrate",
        fatal: false,
        worker: asWorker(async (signal) => {
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              subAborted.value = true;
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                subAborted.value = true;
                resolve();
              },
              { once: true },
            );
            setTimeout(() => reject(new Error("timed out without abort")), 500);
          });
        }),
      },
      { name: "descriptor", fatal: false, worker: noop },
    ]);
    expect(code).toBe(1);
    expect(subAborted.value).toBe(true);
  });

  it("does not abort the others when a non-fatal worker fails", async () => {
    let tipCompleted = false;
    const code = await runWorkers([
      {
        name: "tip",
        fatal: true,
        worker: asWorker(async (signal) => {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => {
              tipCompleted = true;
              resolve();
            }, 50);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("tip was aborted"));
              },
              { once: true },
            );
          });
        }),
      },
      {
        name: "substrate",
        fatal: false,
        worker: asWorker(async () => {
          throw new Error("substrate boom");
        }),
      },
      { name: "descriptor", fatal: false, worker: noop },
    ]);
    // A non-fatal failure → exit code 1, but the fatal worker still completed.
    expect(code).toBe(1);
    expect(tipCompleted).toBe(true);
  });
});
