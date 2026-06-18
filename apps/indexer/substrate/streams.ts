// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Substrate-specific rxjs bridge: a polkadot `subscribe(cb): Promise<UnsubFn>`
// becomes an Observable. Generic bridges (AbortSignal, disconnect, effect
// runner) live in `../rx`.

import { Observable } from "rxjs";

import type { UnsubFn } from "../substrate-client";

export function fromChainSubscription<T>(
  subscribe: (cb: (value: T) => void) => Promise<UnsubFn>,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    let unsub: UnsubFn | null = null;
    let cancelled = false;
    subscribe((value) => subscriber.next(value)).then(
      (fn) => {
        // Teardown can win the race against the subscribe promise resolving;
        // `cancelled` ensures a late unsub handle is still invoked, not leaked.
        if (cancelled) fn();
        else unsub = fn;
      },
      (err) => subscriber.error(err),
    );
    return () => {
      cancelled = true;
      unsub?.();
    };
  });
}
