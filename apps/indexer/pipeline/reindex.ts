// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R4 drop-state / reindex (spec §8) and the --list-indexables printer.
//
// Step order is deliberate crash-safety: generation bump and coverage clear
// come BEFORE dropState, so a crash between any two steps leaves at worst
// extra rows with no coverage claiming them — harmless, because the
// idempotent re-walk overwrites them. (Rows dropped first would, on crash,
// leave coverage claiming rows that no longer exist: a silently-covered
// permanent gap.) The generation bump also invalidates any in-flight
// coverage flush from a concurrently running daemon (`setCoverageIfGeneration`).

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { parseCoverage } from "./coverage";
import { isBlockIndexable, type Indexable } from "./plugin";

/**
 * Drop state for the named indexables ([] = all) so the next run re-walks
 * them from their start block. Returns the names processed.
 */
export async function runReindex(
  db: DatabaseAdapter,
  registry: Indexable[],
  targets: string[],
): Promise<string[]> {
  const byName = new Map(registry.map((p) => [p.name, p]));
  const names = targets.length === 0 ? registry.map((p) => p.name) : targets;
  for (const name of names) {
    if (!byName.has(name)) {
      throw new Error(
        `[indexer] unknown indexable "${name}" — valid names: ${registry.map((p) => p.name).join(", ")}`,
      );
    }
  }
  for (const name of names) {
    const plugin = byName.get(name)!;
    if (isBlockIndexable(plugin)) {
      await db.bumpIndexerGeneration(name); // (1) kill stale in-flight flushes
      await db.clearCoverage(name); // (2) forget the plan
      await plugin.dropState(db); // (3) drop the rows
    } else {
      // Scheduler-driven snapshots have no coverage; dropState only — the
      // next poll refills (spec §8).
      await plugin.dropState(db);
    }
    console.log(`[indexer] reindex: dropped state for "${name}"`);
  }
  return names;
}

/** One line per registered indexable — the --list-indexables output. */
export async function formatIndexables(
  db: DatabaseAdapter,
  registry: Indexable[],
): Promise<string> {
  const lines: string[] = [];
  for (const p of registry) {
    if (isBlockIndexable(p)) {
      const gen = await db.getIndexerGeneration(p.name);
      const raw = await db.getCoverage(p.name);
      let summary = "coverage: (none)";
      if (raw !== null) {
        try {
          const cov = parseCoverage(JSON.parse(raw));
          if (cov) {
            summary =
              `coverage: low=${cov.low ?? "-"} high=${cov.high ?? "-"} gaps=${cov.gaps.length}` +
              ` prunedFloor=${cov.prunedFloor ?? "-"} gen=${cov.gen}`;
          } else {
            summary = "coverage: (malformed — will re-walk)";
          }
        } catch {
          summary = "coverage: (malformed — will re-walk)";
        }
      }
      lines.push(
        `block     ${p.name.padEnd(18)} domain=${p.domain.padEnd(13)} gen=${gen} ${summary}`,
      );
    } else {
      lines.push(`snapshot  ${p.name.padEnd(18)} driver=${p.driver ?? "scheduler"}`);
    }
  }
  return lines.join("\n");
}
