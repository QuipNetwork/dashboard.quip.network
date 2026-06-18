// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Generic rxjs bridges shared across workers: AbortSignal → stream, and an
// effect runner that logs+swallows so one failed side-effect never tears a
// stream down. Substrate-specific bridges (chain subscriptions, disconnect)
// live in substrate/streams.ts.

import { EMPTY, Observable, catchError, defer, ignoreElements } from "rxjs";

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
