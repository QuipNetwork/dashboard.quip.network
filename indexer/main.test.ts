// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { AuthError } from "./client";
import { runWorkers } from "./main";

describe("runWorkers", () => {
  it("returns 0 when the tip worker completes normally", async () => {
    const tipRan = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        tipRan.value = true;
      },
    });
    expect(code).toBe(0);
    expect(tipRan.value).toBe(true);
  });

  it("returns 1 when the tip worker throws AuthError", async () => {
    const code = await runWorkers({
      runTip: async () => {
        throw new AuthError("401");
      },
    });
    expect(code).toBe(1);
  });

  it("returns 1 when a non-auth error leaks out of the tip worker", async () => {
    const code = await runWorkers({
      runTip: async () => {
        throw new Error("boom");
      },
    });
    expect(code).toBe(1);
  });

  it("runs tip and substrate together when runSubstrate is provided", async () => {
    let tipRan = false;
    let subRan = false;
    const code = await runWorkers({
      runTip: async () => {
        tipRan = true;
      },
      runSubstrate: async () => {
        subRan = true;
      },
    });
    expect(code).toBe(0);
    expect(tipRan).toBe(true);
    expect(subRan).toBe(true);
  });

  it("aborts substrate when the tip worker throws AuthError", async () => {
    const subAborted = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        throw new AuthError("401");
      },
      runSubstrate: async (signal) => {
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
      },
    });
    expect(code).toBe(1);
    expect(subAborted.value).toBe(true);
  });

  it("does not abort the tip worker when substrate fails", async () => {
    let tipCompleted = false;
    const code = await runWorkers({
      runTip: async (signal) => {
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
      runSubstrate: async () => {
        throw new Error("substrate boom");
      },
    });
    // Substrate failure → exit code 1, but the tip worker completed.
    expect(code).toBe(1);
    expect(tipCompleted).toBe(true);
  });

  it("substrate auth error does not abort the tip worker", async () => {
    let tipCompleted = false;
    const code = await runWorkers({
      runTip: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        tipCompleted = true;
      },
      runSubstrate: async () => {
        throw new AuthError("substrate 401");
      },
    });
    expect(code).toBe(1);
    expect(tipCompleted).toBe(true);
  });
});
