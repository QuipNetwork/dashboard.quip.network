// SPDX-License-Identifier: AGPL-3.0-or-later

// A membership set with a bounded memory footprint, used where keys arrive in a
// stream and only need to be remembered for a recent window (e.g. de-duplicating
// per-block work on a long-lived connection, where an unbounded Set would leak).
//
// Two generations: adds land in `current`; when it fills to `cap`, `current`
// becomes `previous` (the older generation is dropped) and a fresh `current`
// starts. Membership checks both, so a key survives for between `cap` and
// `2 * cap` subsequent additions before eviction, and total retention never
// exceeds `2 * cap`. O(1) per operation, no per-key bookkeeping.
export class BoundedKeySet {
  private current = new Set<string>();
  private previous = new Set<string>();

  constructor(private readonly cap: number) {}

  has(key: string): boolean {
    return this.current.has(key) || this.previous.has(key);
  }

  add(key: string): void {
    if (this.current.size >= this.cap) {
      this.previous = this.current;
      this.current = new Set();
    }
    this.current.add(key);
  }

  delete(key: string): void {
    this.current.delete(key);
    this.previous.delete(key);
  }

  get size(): number {
    return this.current.size + this.previous.size;
  }
}
