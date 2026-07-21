// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A generic read-through cache. Callers ask for a value by key and supply the
 * builder that produces it on a miss; the cache decides whether to serve a
 * stored value or run the builder. Keeping this behind an interface lets call
 * sites depend on the contract (and inject a fake in tests) rather than a
 * concrete TTL/eviction policy.
 */
export interface ICache<V> {
  /**
   * Return the value for `key` if a fresh entry exists; otherwise run `build`,
   * store the result, and return it. Concurrent misses for the same key share
   * a single in-flight build (singleflight) so a slow builder isn't run N times
   * under a burst of callers. A rejected build is not stored and propagates to
   * every waiter.
   */
  read(key: string, build: () => Promise<V>): Promise<V>;
  /** Drop any stored value and in-flight build for `key`. */
  invalidate(key: string): void;
}

export interface TtlCacheOptions {
  /** Freshness window in ms. An entry is fresh while `now() - storedAt < ttlMs`,
   *  so `0` disables caching (every non-concurrent read rebuilds). */
  ttlMs: number;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * In-memory {@link ICache} with a time-to-live freshness window and singleflight
 * de-duplication of concurrent builds. Process-local: it holds nothing across
 * restarts and is not shared between instances.
 */
export class TtlCache<V> implements ICache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();
  private readonly inFlight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  async read(key: string, build: () => Promise<V>): Promise<V> {
    const fresh = this.entries.get(key);
    if (fresh && this.now() - fresh.at < this.ttlMs) return fresh.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const build$ = build()
      .then((value) => {
        this.entries.set(key, { value, at: this.now() });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, build$);
    return build$;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.inFlight.delete(key);
  }
}
