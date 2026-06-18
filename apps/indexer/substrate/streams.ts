// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Substrate-specific rxjs bridges where the polkadot callback / promise world
// meets streams. Generic bridges (AbortSignal, effect runner) live in `../rx`.

import { Observable } from "rxjs";

import type { UnsubFn } from "../substrate-client";
import type { ConnectionControl } from "./ports";

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

// Errors on disconnect so a drop flows through the worker's `retry` like a
// failed connect.
export function fromDisconnect(client: ConnectionControl): Observable<never> {
  return new Observable<never>((subscriber) => {
    const off = client.onDisconnected(() => {
      subscriber.error(new Error("substrate connection dropped"));
    });
    return off;
  });
}
