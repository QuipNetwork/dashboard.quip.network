// SPDX-License-Identifier: AGPL-3.0-or-later

/** Split `items` into consecutive chunks of at most `size` (which must be >= 1). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
