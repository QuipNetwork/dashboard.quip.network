// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Generic rxjs bridges shared across workers: AbortSignal → stream,
// disconnect → error, and an effect runner that logs+swallows so one failed
// side-effect never tears a stream down. The substrate-specific subscription
// bridge (chain heads/events) lives in substrate/streams.ts.

import { EMPTY, Observable, catchError, defer, ignoreElements } from "rxjs";

// Any client whose drop can be observed via a callback. Structurally satisfied
// by the substrate client (its `onDisconnected` returns an unsubscribe fn).
export interface Disconnectable {
  onDisconnected(cb: () => void): () => void;
}

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

// Errors on disconnect so a drop flows through a worker's `retry` like a
// failed connect.
export function fromDisconnect(client: Disconnectable): Observable<never> {
  return new Observable<never>((subscriber) => {
    const off = client.onDisconnected(() => {
      subscriber.error(new Error("connection dropped"));
    });
    return off;
  });
}

// Runs an async side-effect as a stream step, logging and swallowing its error
// so one failed write/poll never tears the stream down.
export function runEffect(label: string, run: () => Promise<void>): Observable<never> {
  return defer(run).pipe(
    catchError((e) => {
      console.warn(`[indexer] ${label} failed:`, e);
      return EMPTY;
    }),
    ignoreElements(),
  );
}
