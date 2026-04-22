// SPDX-License-Identifier: AGPL-3.0-or-later

export interface IndexerConfig {
  nodeUrl: string;
  token: string | undefined;
  pollIntervalSec: number;
  nodesRefreshSec: number;
  backfillFromEpoch: number | undefined;
  // Explicit override for "which peer in the nodes snapshot is this dashboard's
  // operator?". Required when the configured quip-node doesn't include itself
  // in its own peer list (e.g. an aggregator node polling its peers), in which
  // case publicHost matching can never succeed.
  selfAddress: string | undefined;
  once: boolean;
  verbose: boolean;
}

const DEFAULTS = {
  nodeUrl: "https://qpu-1.nodes.quip.network",
  pollIntervalSec: 8,
  nodesRefreshSec: 45,
};

function parseIntStrict(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`[indexer] ${name} must be an integer, got: ${raw}`);
  }
  return n;
}

function takeFlag(argv: string[], name: string): string | boolean | undefined {
  // supports --name=value, --name value, and bare boolean --name
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return true;
      return next;
    }
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
  }
  return undefined;
}

export function parseConfig(argv: string[] = Bun.argv.slice(2)): IndexerConfig {
  const nodeUrlFlag = takeFlag(argv, "--node-url");
  const tokenFlag = takeFlag(argv, "--token");
  const pollFlag = takeFlag(argv, "--poll-interval");
  const nodesFlag = takeFlag(argv, "--nodes-refresh");
  const backfillFlag = takeFlag(argv, "--backfill-from-epoch");
  const selfAddressFlag = takeFlag(argv, "--self-address");
  const onceFlag = takeFlag(argv, "--once");
  const verboseFlag = takeFlag(argv, "--verbose");

  const nodeUrl =
    (typeof nodeUrlFlag === "string" ? nodeUrlFlag : undefined) ??
    process.env.QUIP_NODE_URL ??
    DEFAULTS.nodeUrl;

  const token =
    (typeof tokenFlag === "string" ? tokenFlag : undefined) ?? process.env.QUIP_NODE_TOKEN;

  const pollIntervalSec =
    typeof pollFlag === "string"
      ? parseIntStrict("--poll-interval", pollFlag)
      : process.env.POLL_INTERVAL_SEC
        ? parseIntStrict("POLL_INTERVAL_SEC", process.env.POLL_INTERVAL_SEC)
        : DEFAULTS.pollIntervalSec;

  const nodesRefreshSec =
    typeof nodesFlag === "string"
      ? parseIntStrict("--nodes-refresh", nodesFlag)
      : process.env.NODES_REFRESH_SEC
        ? parseIntStrict("NODES_REFRESH_SEC", process.env.NODES_REFRESH_SEC)
        : DEFAULTS.nodesRefreshSec;

  const backfillRaw =
    (typeof backfillFlag === "string" ? backfillFlag : undefined) ??
    process.env.BACKFILL_FROM_EPOCH;
  const backfillFromEpoch = backfillRaw
    ? parseIntStrict("--backfill-from-epoch", backfillRaw)
    : undefined;

  const selfAddress =
    (typeof selfAddressFlag === "string" ? selfAddressFlag : undefined) ?? process.env.SELF_ADDRESS;

  const once = onceFlag === true || onceFlag === "true" || onceFlag === "1";
  const verbose =
    verboseFlag === true ||
    verboseFlag === "true" ||
    verboseFlag === "1" ||
    process.env.VERBOSE === "1";

  return {
    nodeUrl: nodeUrl.replace(/\/+$/, ""),
    token,
    pollIntervalSec,
    nodesRefreshSec,
    backfillFromEpoch,
    selfAddress: selfAddress?.trim() ? selfAddress.trim() : undefined,
    once,
    verbose,
  };
}
