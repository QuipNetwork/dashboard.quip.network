// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of the substrate worker. Everything else under `substrate/`
// is an internal stream module or port.

export { SubstrateWorker, type SubstrateWorkerDeps } from "./worker";
export type { Worker } from "./ports";
