// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rxjs bridges where the callback / promise / AbortSignal world meets streams.

import { EMPTY, Observable, catchError, defer, ignoreElements } from "rxjs";

import type { UnsubFn } from "../substrate-client";
import type { ConnectionControl } from "./ports";

export function fromAbortSignal(signal: AbortSignal): Observable<void> {
  return new Observable<void>((subscriber) => {
    if (signal.aborted) {
      subscriber.next();
      subscriber.complete();
      return;
    }
    const onAbort = () => {
      subscriber.next();
      subscriber.complete();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  });
}

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

// Runs an async side-effect as a stream step, logging and swallowing its error
// so one failed write/poll never tears the connection down.
export function runEffect(label: string, run: () => Promise<void>): Observable<never> {
  return defer(run).pipe(
    catchError((e) => {
      console.warn(`[indexer/substrate] ${label} failed:`, e);
      return EMPTY;
    }),
    ignoreElements(),
  );
}
