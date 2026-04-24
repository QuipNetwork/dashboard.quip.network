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
});
