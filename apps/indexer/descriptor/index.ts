// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of the descriptor ingest logic. The dedicated worker is
// gone — the `node-descriptors` snapshot plugin (pipeline/plugins) drives
// the same iteration from the substrate worker's SnapshotScheduler.

export { runDescriptorIteration, type DescriptorIterationDeps } from "./iteration";
