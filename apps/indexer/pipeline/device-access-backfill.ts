// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One-shot device_access_time backfill: winner rows indexed before migration
// 0006 have `device_access_time_us` null even where the chain (runtime ≥112)
// carried a reported value. At startup we detect that condition once and
// schedule the existing winners reindex to re-derive every row.
//
// The core constraint is the durable latch, not the detection: the field is
// self-reported and usually absent, so "every row is null" can be legitimate
// forever — without the marker a naive check would re-reindex on every boot.
// The marker's PRESENCE means the decision was already made; its value only
// records what was decided, for observability.
//
// Crash-safety: the marker is written BEFORE runReindex. A crash after the
// marker but mid-reindex never schedules a second generation bump on restart
// — runReindex's own step ordering (generation bump → coverage clear →
// dropState) already guarantees the interrupted re-walk resumes and its
// idempotent walk overwrites any surviving rows (see reindex.ts header and
// the crash test in reindex.test.ts). The residual window — crash between
// the marker write and the generation bump — loses only the auto-trigger;
// a manual `--reindex winners` recovers, and we accept that over the inverse
// failure (a repeated full reindex on every crash-loop boot).

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { Indexable } from "./plugin";
import { runReindex } from "./reindex";

export type DeviceAccessTimeBackfillStatus = "triggered" | "not-needed";

export interface DeviceAccessTimeBackfillDecision {
  status: DeviceAccessTimeBackfillStatus;
  // Whether THIS call started a reindex (false when the marker latch or the
  // data made it unnecessary). Callers use it only for logging.
  ranNow: boolean;
}

/**
 * Run the one-shot detection and (at most once per deployment) the winners
 * auto-reindex. Called from main() after migrations, before workers start.
 * Returns the decision so the caller can surface it via observability.
 */
export async function ensureDeviceAccessTimeBackfill(
  db: DatabaseAdapter,
  registry: Indexable[],
): Promise<DeviceAccessTimeBackfillDecision> {
  const marker = await db.getDeviceAccessTimeBackfillMarker();
  if (marker !== null) {
    // Latched — never re-trigger, whatever the data looks like now. An
    // unrecognized value (manual edit) still latches; report "triggered"
    // rather than falsely claiming the data was ever verified present.
    return { status: marker === "not-needed" ? "not-needed" : "triggered", ranNow: false };
  }

  const probe = await db.probeDeviceAccessTimeData();
  if (!probe.hasBlocks || probe.hasReported) {
    // Fresh DB (normal indexing populates the field going forward) or a
    // reported value already exists — latch without reindexing.
    await db.setDeviceAccessTimeBackfillMarker("not-needed");
    return { status: "not-needed", ranNow: false };
  }

  // Blocks exist and none carries a reported value: rows may predate
  // migration 0006. Latch first (see crash-safety note above), then reuse
  // the exact `--reindex winners` code path.
  await db.setDeviceAccessTimeBackfillMarker("triggered");
  console.log(
    "[indexer] device_access_time_us missing on every indexed winner row — " +
      "scheduling one-shot winners reindex to backfill",
  );
  await runReindex(db, registry, ["winners"]);
  return { status: "triggered", ranNow: true };
}
