// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Formatters for chain-native values: SS58 addresses (long) and u128 token
// balances (need decimal scaling). Kept separate from `format.ts` so the
// chain-specific concerns don't bleed into shared utilities.

/**
 * quip-protocol-rs uses 12 decimal places for the native token (standard
 * substrate convention). 1 UNIT = 10^12 base units, so a `deposit` of
 * "1000000000000" displays as "1 QUIP".
 *
 * Centralized so future decimal-change migrations only touch this constant.
 */
const TOKEN_DECIMALS = 12;
const TOKEN_SYMBOL = "QUIP";

/**
 * Render a u128-as-string balance in human units. Uses BigInt internally so
 * values that exceed Number.MAX_SAFE_INTEGER (≥ ~9 quadrillion base units)
 * round correctly.
 *
 * Returns "—" for parse failures so the UI doesn't render NaN.
 */
export function formatBalance(raw: string, fractionDigits = 4): string {
  if (!raw || raw.length === 0) return "—";
  let big: bigint;
  try {
    big = BigInt(raw);
  } catch {
    return "—";
  }
  const divisor = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = big / divisor;
  const remainder = big % divisor;
  // Pad the remainder to TOKEN_DECIMALS, then trim to fractionDigits.
  const remainderStr = remainder.toString().padStart(TOKEN_DECIMALS, "0");
  const fractional = remainderStr.slice(0, fractionDigits);
  // Strip trailing zeros from the fractional segment unless it's all zeros
  // — keep "1" recognizable as a whole token, but "1.2300" → "1.23".
  const trimmed = fractional.replace(/0+$/, "");
  const display = trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
  return `${display} ${TOKEN_SYMBOL}`;
}

/**
 * Shorten an SS58 address to "head…tail" form for dense table rows.
 * Default head/tail of 6/4 chars keeps prefixes (e.g. "5GrwvaEF…1234")
 * recognizable while keeping the cell narrow.
 */
export function shortAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * Render a `BlockRecord.nonce` (large decimal string from
 * `quantum_pow.WinningSolutions.nonce`, up to 256-bit) as a left-padded
 * lowercase hex string with `0x` prefix. Hex is ~20 chars shorter than the
 * decimal form and matches the convention every block explorer / wallet
 * uses for raw nonce values.
 *
 * Pads to 64 hex chars (32 bytes) so column widths stay stable across the
 * table, and so a leading-zero nonce is visually distinguishable from a
 * full-width one. Returns the raw string unmodified if it can't be parsed
 * as a BigInt (defensive — the chain shouldn't emit non-numeric nonces).
 */
export function formatNonce(decimal: string): string {
  if (!decimal) return "—";
  let big: bigint;
  try {
    big = BigInt(decimal);
  } catch {
    return decimal;
  }
  return `0x${big.toString(16).padStart(64, "0")}`;
}
