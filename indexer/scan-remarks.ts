// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Standalone CLI: scan a finalized-block range on the validator RPC for
// `System.remark{,_with_event}` extrinsics, attempt to decode each as a
// `quip.node_descriptor.v1` payload, and report what landed.
//
// Reuses the production substrate-client + descriptor-validator so the
// decode path here matches what the descriptor-worker would see in steady
// state. No DB touch — purely a chain-truth dump.
//
// Usage:
//   QUIP_VALIDATOR_RPC_URL=wss://… bun run indexer/scan-remarks.ts
//   QUIP_VALIDATOR_RPC_URL=wss://… bun run indexer/scan-remarks.ts --from 1 --to 5000
//   QUIP_VALIDATOR_RPC_URL=wss://… bun run indexer/scan-remarks.ts --recent 500 --verbose

import { parseAndValidateDescriptor } from "./descriptor-validator";
import { PolkadotSubstrateClient } from "./substrate-client";

interface ScanOptions {
  rpcUrl: string;
  from: bigint | null;
  to: bigint | null;
  recent: number | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): ScanOptions {
  const opts: ScanOptions = {
    rpcUrl: process.env.QUIP_VALIDATOR_RPC_URL ?? "",
    from: null,
    to: null,
    recent: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eat = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = eat("--rpc-url")) !== null) opts.rpcUrl = v;
    else if ((v = eat("--from")) !== null) opts.from = BigInt(v);
    else if ((v = eat("--to")) !== null) opts.to = BigInt(v);
    else if ((v = eat("--recent")) !== null) opts.recent = Number(v);
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
  }
  return opts;
}

function usage(): never {
  console.error(
    "scan-remarks: scan a validator's finalized blocks for quip.node_descriptor.v1 remarks\n\n" +
      "Set QUIP_VALIDATOR_RPC_URL (or pass --rpc-url) to a ws:// or wss:// endpoint.\n\n" +
      "  --from N        starting block number (default: head - 200)\n" +
      "  --to N          ending block number (default: head)\n" +
      "  --recent N      shorthand for --from (head-N) --to head\n" +
      "  --verbose, -v   print full validated descriptor JSON",
  );
  process.exit(2);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.rpcUrl) {
    console.error("scan-remarks: QUIP_VALIDATOR_RPC_URL is required (or pass --rpc-url)");
    usage();
  }

  const client = new PolkadotSubstrateClient(opts.rpcUrl);
  console.log(`[scan] connecting to ${opts.rpcUrl}`);
  await client.connect();

  try {
    // Determine the scan window. We need the chain head before we can
    // resolve "--recent N" or the default "head - 200" floor. The chain
    // head also caps --to so we don't poll past the tip.
    // We can't ask the client for head directly without re-implementing it;
    // grab it via getBlockHeader of the latest finalized via the workaround:
    // ask for block "999999999" — the client returns null, no good. Better:
    // use chainHead via a one-shot subscribeFinalizedHeads.
    const head = await getFinalizedHead(client);
    if (head === null) {
      console.error("[scan] failed to read finalized head — is the chain producing blocks?");
      return 1;
    }

    let from: bigint;
    let to: bigint;
    if (opts.from !== null && opts.to !== null) {
      from = opts.from;
      to = opts.to;
    } else if (opts.recent !== null) {
      to = head;
      from = head - BigInt(opts.recent) + 1n;
    } else if (opts.from !== null) {
      from = opts.from;
      to = head;
    } else {
      // Default: most recent 200 blocks.
      to = head;
      from = head - 200n + 1n;
    }
    if (from < 1n) from = 1n;
    if (to > head) to = head;

    console.log(`[scan] head=${head}, scanning blocks ${from}..${to} (${to - from + 1n} blocks)`);

    let blocksWithRemarks = 0;
    let totalRemarks = 0;
    let validDescriptors = 0;
    let rejectedRemarks = 0;
    const accountSet = new Set<string>();

    for (let n = from; n <= to; n++) {
      const remarks = await client.getRemarksAtBlock(n.toString());
      if (remarks === null) {
        console.warn(`[scan] block ${n}: not found on chain (skipped)`);
        continue;
      }
      if (remarks.length === 0) continue;
      blocksWithRemarks++;
      totalRemarks += remarks.length;
      for (const r of remarks) {
        const result = parseAndValidateDescriptor(r.body);
        if (result.ok) {
          validDescriptors++;
          accountSet.add(r.sender);
          const d = result.descriptor;
          const bits: string[] = [
            `nodeName=${d.nodeName}`,
            d.runtime?.quipVersion ? `quip=${d.runtime.quipVersion}` : null,
            d.miners ? `miners=${Object.keys(d.miners).length}` : null,
            d.systemInfo?.gpus?.length ? `gpus=${d.systemInfo.gpus.length}` : null,
          ].filter((s): s is string => s !== null);
          console.log(
            `  ✓ block ${r.blockNumber} ext ${r.extrinsicIndex} from ${r.sender} — ${bits.join(", ")}`,
          );
          if (opts.verbose) {
            console.log("    " + JSON.stringify(d, null, 2).replaceAll("\n", "\n    "));
          }
        } else {
          rejectedRemarks++;
          console.log(
            `  ✗ block ${r.blockNumber} ext ${r.extrinsicIndex} from ${r.sender} — REJECTED: ${result.reason}`,
          );
          // Truncate the body so a non-descriptor remark (Polkadot UI tags,
          // governance memos, etc.) doesn't spam the terminal.
          const preview =
            r.body.length > 120 ? `${r.body.slice(0, 120)}…(${r.body.length} bytes)` : r.body;
          console.log(`    body: ${JSON.stringify(preview)}`);
        }
      }
    }

    console.log("");
    console.log(`[scan] done.`);
    console.log(`  blocks scanned:        ${to - from + 1n}`);
    console.log(`  blocks with remarks:   ${blocksWithRemarks}`);
    console.log(`  total remarks:         ${totalRemarks}`);
    console.log(`  valid descriptors:     ${validDescriptors}`);
    console.log(`  rejected remarks:      ${rejectedRemarks}`);
    console.log(`  unique signer accounts:${accountSet.size}`);
    return validDescriptors > 0 ? 0 : 1;
  } finally {
    await client.disconnect();
  }
}

/**
 * One-shot read of the current finalized head height. We subscribe, wait
 * for one event, then unsubscribe. The subscribe surface is what the
 * substrate worker uses in production — reusing it here keeps the client
 * surface area minimal.
 */
async function getFinalizedHead(client: PolkadotSubstrateClient): Promise<bigint | null> {
  return new Promise<bigint | null>(async (resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    let resolved = false;
    const unsub = await client.subscribeFinalizedHeads((h) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        resolve(BigInt(h.number));
      } catch {
        resolve(null);
      }
      // Detach in the next microtask so polkadot.js doesn't fire the
      // callback synchronously inside its own unsub bookkeeping.
      queueMicrotask(() => unsub());
    });
  });
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("[scan] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
