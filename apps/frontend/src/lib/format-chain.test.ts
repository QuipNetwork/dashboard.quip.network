// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { formatBalance, formatNonce, shortAddress } from "./format-chain";

describe("formatBalance", () => {
  test("renders whole-unit balances without trailing zeros", () => {
    expect(formatBalance("1000000000000")).toBe("1 QUIP");
    expect(formatBalance("7000000000000")).toBe("7 QUIP");
  });

  test("trims trailing zeros in the fractional segment", () => {
    // 1.23 QUIP → 1230000000000 base units
    expect(formatBalance("1230000000000")).toBe("1.23 QUIP");
  });

  test("respects fractionDigits cap (default 4)", () => {
    // 1.234567 QUIP → 1234567000000 base units. Default cap → "1.2345 QUIP".
    expect(formatBalance("1234567000000")).toBe("1.2345 QUIP");
  });

  test("handles zero", () => {
    expect(formatBalance("0")).toBe("0 QUIP");
  });

  test("handles values larger than Number.MAX_SAFE_INTEGER", () => {
    // 10^18 base units = 1 million QUIP. JS Number can't represent
    // 10^18 exactly; BigInt handles it cleanly.
    expect(formatBalance("1000000000000000000")).toBe("1000000 QUIP");
  });

  test("returns '—' on malformed input", () => {
    expect(formatBalance("")).toBe("—");
    expect(formatBalance("not a number")).toBe("—");
  });
});

describe("shortAddress", () => {
  test("truncates long SS58 addresses", () => {
    expect(shortAddress("5GrwvaEFAbCdEfGhIjKlMnOp1234")).toBe("5Grwva…1234");
  });

  test("returns short addresses unchanged", () => {
    expect(shortAddress("abc1234")).toBe("abc1234");
  });
});

describe("formatNonce", () => {
  test("renders a decimal nonce as zero-padded lowercase hex with 0x prefix", () => {
    // The example from the dashboard's MyNode footer:
    // 53951056478492347705757702584223568380911492843421308842151793816201813122786
    expect(
      formatNonce("53951056478492347705757702584223568380911492843421308842151793816201813122786"),
    ).toBe("0x7747374142d650a869c7c541d4e71e8580025eec9801e479b4180fff28415ee2");
  });

  test("pads short nonces to 64 hex chars so column widths stay stable", () => {
    expect(formatNonce("0")).toBe(`0x${"0".repeat(64)}`);
    expect(formatNonce("1")).toBe(`0x${"0".repeat(63)}1`);
    expect(formatNonce("255")).toBe(`0x${"0".repeat(62)}ff`);
  });

  test("returns the placeholder for empty input", () => {
    expect(formatNonce("")).toBe("—");
  });

  test("returns the input unchanged when not a valid number", () => {
    expect(formatNonce("not a number")).toBe("not a number");
  });
});
