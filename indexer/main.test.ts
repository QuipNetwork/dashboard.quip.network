// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { AuthError } from "./client";
import { runWorkers } from "./main";

describe("runWorkers", () => {
  it("returns 0 when both workers complete normally", async () => {
    const tipRan = { value: false };
    const bfRan = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        tipRan.value = true;
      },
      runBackfill: async () => {
        bfRan.value = true;
      },
    });
    expect(code).toBe(0);
    expect(tipRan.value).toBe(true);
    expect(bfRan.value).toBe(true);
  });

  it("returns 1 and aborts the sibling when one worker throws AuthError", async () => {
    const bfAborted = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        throw new AuthError("401");
      },
      runBackfill: async (signal) => {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            bfAborted.value = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              bfAborted.value = true;
              resolve();
            },
            { once: true },
          );
          setTimeout(() => reject(new Error("timed out without abort")), 500);
        });
      },
    });
    expect(code).toBe(1);
    expect(bfAborted.value).toBe(true);
  });

  it("returns 1 when a non-auth error leaks out of a worker", async () => {
    const code = await runWorkers({
      runTip: async () => {
        throw new Error("boom");
      },
      runBackfill: async () => {
        /* finishes fast */
      },
    });
    expect(code).toBe(1);
  });

  it("runs three workers when runSubstrate is provided", async () => {
    let tipRan = false;
    let bfRan = false;
    let subRan = false;
    const code = await runWorkers({
      runTip: async () => {
        tipRan = true;
      },
      runBackfill: async () => {
        bfRan = true;
      },
      runSubstrate: async () => {
        subRan = true;
      },
    });
    expect(code).toBe(0);
    expect(tipRan).toBe(true);
    expect(bfRan).toBe(true);
    expect(subRan).toBe(true);
  });

  it("does not abort siblings when substrate worker fails", async () => {
    let tipCompleted = false;
    let bfCompleted = false;
    const code = await runWorkers({
      runTip: async (signal) => {
        // Sleep briefly, then succeed if not aborted.
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
      },
      runBackfill: async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            bfCompleted = true;
            resolve();
          }, 50);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("backfill was aborted"));
            },
            { once: true },
          );
        });
      },
      runSubstrate: async () => {
        throw new Error("substrate boom");
      },
    });
    // Substrate failure → exit code 1, but REST workers completed.
    expect(code).toBe(1);
    expect(tipCompleted).toBe(true);
    expect(bfCompleted).toBe(true);
  });

  it("substrate auth error does not abort siblings", async () => {
    let tipCompleted = false;
    const code = await runWorkers({
      runTip: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        tipCompleted = true;
      },
      runBackfill: async () => {},
      runSubstrate: async () => {
        throw new AuthError("substrate 401");
      },
    });
    expect(code).toBe(1);
    expect(tipCompleted).toBe(true);
  });
});
