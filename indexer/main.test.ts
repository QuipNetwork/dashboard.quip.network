// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { runWorkers } from "./main";

const noopRunner = async () => {
  // No-op for unused worker slots in a focused test case.
};

describe("runWorkers", () => {
  it("returns 0 when every worker completes normally", async () => {
    let tipRan = false;
    let subRan = false;
    let descRan = false;
    const code = await runWorkers({
      runTip: async () => {
        tipRan = true;
      },
      runSubstrate: async () => {
        subRan = true;
      },
      runDescriptor: async () => {
        descRan = true;
      },
    });
    expect(code).toBe(0);
    expect(tipRan).toBe(true);
    expect(subRan).toBe(true);
    expect(descRan).toBe(true);
  });

  it("returns 1 when the tip worker throws", async () => {
    const code = await runWorkers({
      runTip: async () => {
        throw new Error("boom");
      },
      runSubstrate: noopRunner,
      runDescriptor: noopRunner,
    });
    expect(code).toBe(1);
  });

  it("aborts substrate when the tip worker throws", async () => {
    const subAborted = { value: false };
    const code = await runWorkers({
      runTip: async () => {
        throw new Error("tip blew up");
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
      runDescriptor: noopRunner,
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
      runDescriptor: noopRunner,
    });
    // Substrate failure → exit code 1, but the tip worker completed.
    expect(code).toBe(1);
    expect(tipCompleted).toBe(true);
  });
});
