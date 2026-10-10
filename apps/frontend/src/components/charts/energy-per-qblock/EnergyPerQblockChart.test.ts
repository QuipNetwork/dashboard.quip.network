// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { showPoints } from "./EnergyPerQblockChart";

describe("showPoints", () => {
  test("shows points when every series has at most one point", () => {
    expect(
      showPoints([
        { id: "CPU", data: [{ x: 1, y: 100 }] },
        { id: "GPU", data: [{ x: 1, y: 200 }] },
        { id: "OTHER", data: [] },
      ]),
    ).toBe(true);
  });

  test("hides points when a series has two points", () => {
    expect(
      showPoints([
        { id: "CPU", data: [{ x: 1, y: 100 }] },
        {
          id: "GPU",
          data: [
            { x: 1, y: 200 },
            { x: 2, y: 300 },
          ],
        },
      ]),
    ).toBe(false);
  });
});
