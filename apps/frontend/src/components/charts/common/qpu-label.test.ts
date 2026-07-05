// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { QPU_DAILY_BUDGET_MIN } from "./normalized-composition";
import { displayLabelForCategory, qpuDisplayLabel } from "./qpu-label";

describe("qpuDisplayLabel", () => {
  test('returns "QPU20m", derived from QPU_DAILY_BUDGET_MIN', () => {
    expect(qpuDisplayLabel()).toBe("QPU20m");
    expect(qpuDisplayLabel()).toBe(`QPU${QPU_DAILY_BUDGET_MIN}m`);
  });
});

describe("displayLabelForCategory", () => {
  test("relabels QPU to the budget-qualified display label", () => {
    expect(displayLabelForCategory("QPU")).toBe("QPU20m");
  });

  test("passes every other id through unchanged", () => {
    for (const id of ["CPU", "GPU", "OTHER", "All", "QPUWC", "5abc123"]) {
      expect(displayLabelForCategory(id)).toBe(id);
    }
  });
});
