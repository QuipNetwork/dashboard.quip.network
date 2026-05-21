// SPDX-License-Identifier: AGPL-3.0-or-later

export interface IndexerConfig {
  nodeUrl: string;
  token: string | undefined;
  pollIntervalSec: number;
  nodesRefreshSec: number;
  once: boolean;
  verbose: boolean;
  // Seconds of no `latestBlockIndex` advance (from /api/v1/telemetry/status)
  // after which the indexer emits a WARN that the polled node looks stalled.
  // 0 disables the check.
  stallWarnAfterSec: number;

  // --- Substrate (quip-protocol-rs validator) RPC options ---
  // null = no substrate worker, degraded mode (the indexer still polls REST
  // and the dashboard surfaces null/empty for chain fields). All other
  // substrate options are inert when this is null.
  substrateRpcUrl: string | null;
  // Per-request timeout for WsProvider handshake + RPC calls.
  substrateRpcTimeoutMs: number;
  // Upper bound on the exponential-backoff reconnect loop (±20% jitter).
  substrateReconnectMaxBackoffMs: number;
  // Cadence at which we re-poll BABE epoch state (cheap; epoch changes are
  // ~hourly on quip-protocol-rs spec 101). Also re-polled on every finalized head.
  substrateBabePollSec: number;
  // Cadence at which we re-poll the bigger chain surfaces — quantum_pow.Miners,
  // quantum_pow.Difficulty, session.validators. More expensive: O(miners) RPCs.
  substrateChainPollSec: number;

  // --- Node descriptor indexer (v0.2) ---
  // Substrate block number (as decimal string, u64-precision-safe) the
  // descriptor worker starts scanning from on a fresh database. Resume-
  // from-checkpoint takes over once the first iteration completes; this
  // bound only matters on a never-indexed DB. Default "1" backfills from
  // genesis — acceptable for short-lived testnets; long-running chains
  // should set QUIP_DESCRIPTOR_START_BLOCK to a recent block height to
  // avoid an O(history) catch-up walk.
  descriptorStartBlock: string;
}

const DEFAULTS = {
  nodeUrl: "https://qpu-1.nodes.quip.network",
  pollIntervalSec: 8,
  nodesRefreshSec: 45,
  stallWarnAfterSec: 600, // 10 minutes — longer than typical QPU block time.
  substrateRpcTimeoutMs: 15000,
  substrateReconnectMaxBackoffMs: 60000,
  substrateBabePollSec: 30,
  // Matches BABE slot duration (6s on quip-protocol-rs) so chain_miners
  // and difficulty_history poll once per block. The reads are cheap
  // storage hits and the UI's "Problems Won" tile would otherwise show a
  // ~5min stale snapshot of `quantum_pow.Miners`.
  substrateChainPollSec: 6,
  // "1" backfills from genesis. Operators on long-lived chains override
  // via QUIP_DESCRIPTOR_START_BLOCK.
  descriptorStartBlock: "1",
};

function parseIntStrict(name: string, raw: string): number {
  // `Number()` accepts whitespace, empty string ("" → 0), hex ("0x10" → 16),
  // and scientific notation ("1e3" → 1000) — all of which silently succeed
  // here and can disable features downstream (e.g. `--stall-warn-after=""`
  // would coerce to 0, turning stall detection off without a loud error).
  // Require an explicit decimal integer string.
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`[indexer] ${name} must be a decimal integer, got: ${JSON.stringify(raw)}`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`[indexer] ${name} out of safe integer range, got: ${raw}`);
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
  const onceFlag = takeFlag(argv, "--once");
  const verboseFlag = takeFlag(argv, "--verbose");
  const stallFlag = takeFlag(argv, "--stall-warn-after");

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

  const once = onceFlag === true || onceFlag === "true" || onceFlag === "1";
  const verbose =
    verboseFlag === true ||
    verboseFlag === "true" ||
    verboseFlag === "1" ||
    process.env.VERBOSE === "1";

  const stallWarnAfterSec =
    typeof stallFlag === "string"
      ? parseIntStrict("--stall-warn-after", stallFlag)
      : process.env.STALL_WARN_AFTER_SEC
        ? parseIntStrict("STALL_WARN_AFTER_SEC", process.env.STALL_WARN_AFTER_SEC)
        : DEFAULTS.stallWarnAfterSec;
  if (stallWarnAfterSec < 0) {
    throw new Error(`[indexer] --stall-warn-after must be >= 0, got: ${stallWarnAfterSec}`);
  }

  // --- Substrate options ---
  const substrateRpcUrlFlag = takeFlag(argv, "--substrate-rpc-url");
  const substrateRpcTimeoutFlag = takeFlag(argv, "--substrate-rpc-timeout");
  const substrateBackoffFlag = takeFlag(argv, "--substrate-reconnect-max-backoff");
  const substrateBabePollFlag = takeFlag(argv, "--substrate-babe-poll");
  const substrateChainPollFlag = takeFlag(argv, "--substrate-chain-poll");

  const substrateRpcUrlRaw =
    (typeof substrateRpcUrlFlag === "string" ? substrateRpcUrlFlag : undefined) ??
    process.env.QUIP_VALIDATOR_RPC_URL;
  // Reject empty string explicitly — operators usually mean "leave unset" but
  // a stray `--substrate-rpc-url=` would otherwise produce a connect-time
  // failure deep in the substrate worker.
  if (substrateRpcUrlRaw !== undefined && substrateRpcUrlRaw.trim() === "") {
    throw new Error(
      `[indexer] --substrate-rpc-url cannot be empty (omit the flag/env to disable substrate)`,
    );
  }
  const substrateRpcUrl =
    substrateRpcUrlRaw !== undefined ? substrateRpcUrlRaw.replace(/\/+$/, "") : null;

  const substrateRpcTimeoutMs =
    typeof substrateRpcTimeoutFlag === "string"
      ? parseIntStrict("--substrate-rpc-timeout", substrateRpcTimeoutFlag)
      : process.env.QUIP_VALIDATOR_RPC_TIMEOUT_MS
        ? parseIntStrict("QUIP_VALIDATOR_RPC_TIMEOUT_MS", process.env.QUIP_VALIDATOR_RPC_TIMEOUT_MS)
        : DEFAULTS.substrateRpcTimeoutMs;
  if (substrateRpcTimeoutMs <= 0) {
    throw new Error(`[indexer] substrate RPC timeout must be > 0, got: ${substrateRpcTimeoutMs}`);
  }

  const substrateReconnectMaxBackoffMs =
    typeof substrateBackoffFlag === "string"
      ? parseIntStrict("--substrate-reconnect-max-backoff", substrateBackoffFlag)
      : process.env.QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS
        ? parseIntStrict(
            "QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS",
            process.env.QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS,
          )
        : DEFAULTS.substrateReconnectMaxBackoffMs;
  if (substrateReconnectMaxBackoffMs <= 0) {
    throw new Error(
      `[indexer] substrate reconnect backoff must be > 0, got: ${substrateReconnectMaxBackoffMs}`,
    );
  }

  const substrateBabePollSec =
    typeof substrateBabePollFlag === "string"
      ? parseIntStrict("--substrate-babe-poll", substrateBabePollFlag)
      : process.env.QUIP_VALIDATOR_BABE_POLL_SEC
        ? parseIntStrict("QUIP_VALIDATOR_BABE_POLL_SEC", process.env.QUIP_VALIDATOR_BABE_POLL_SEC)
        : DEFAULTS.substrateBabePollSec;
  if (substrateBabePollSec <= 0) {
    throw new Error(`[indexer] --substrate-babe-poll must be > 0, got: ${substrateBabePollSec}`);
  }

  const substrateChainPollSec =
    typeof substrateChainPollFlag === "string"
      ? parseIntStrict("--substrate-chain-poll", substrateChainPollFlag)
      : process.env.QUIP_VALIDATOR_CHAIN_POLL_SEC
        ? parseIntStrict("QUIP_VALIDATOR_CHAIN_POLL_SEC", process.env.QUIP_VALIDATOR_CHAIN_POLL_SEC)
        : DEFAULTS.substrateChainPollSec;
  if (substrateChainPollSec <= 0) {
    throw new Error(`[indexer] --substrate-chain-poll must be > 0, got: ${substrateChainPollSec}`);
  }

  const descriptorStartFlag = takeFlag(argv, "--descriptor-start-block");
  const descriptorStartRaw =
    (typeof descriptorStartFlag === "string" ? descriptorStartFlag : undefined) ??
    process.env.QUIP_DESCRIPTOR_START_BLOCK ??
    DEFAULTS.descriptorStartBlock;
  // Validate via parseIntStrict to reject hex/scientific/whitespace
  // (consistent with other numeric config), then re-stringify so the
  // worker's BigInt() call doesn't see exotic shapes. We keep it as a
  // string in the IndexerConfig type for u64-precision-safety.
  const descriptorStartBlock = String(
    parseIntStrict("QUIP_DESCRIPTOR_START_BLOCK", descriptorStartRaw),
  );
  if (Number(descriptorStartBlock) < 1) {
    throw new Error(
      `[indexer] QUIP_DESCRIPTOR_START_BLOCK must be >= 1, got: ${descriptorStartBlock}`,
    );
  }

  return {
    nodeUrl: nodeUrl.replace(/\/+$/, ""),
    token,
    pollIntervalSec,
    nodesRefreshSec,
    once,
    verbose,
    stallWarnAfterSec,
    substrateRpcUrl,
    substrateRpcTimeoutMs,
    substrateReconnectMaxBackoffMs,
    substrateBabePollSec,
    substrateChainPollSec,
    descriptorStartBlock,
  };
}
