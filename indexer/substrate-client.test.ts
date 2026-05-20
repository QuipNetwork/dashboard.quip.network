// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  extractNonce,
  FakeSubstrateClient,
  PolkadotSubstrateClient,
  type BlockEvents,
  type BlockWinnerEvent,
  type SubstrateHead,
} from "./substrate-client";

describe("FakeSubstrateClient", () => {
  test("emits finalized head to subscribers and stashes for getBlockHeader", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const received: SubstrateHead[] = [];
    const unsub = await c.subscribeFinalizedHeads((h) => {
      received.push(h);
    });
    const h: SubstrateHead = {
      number: "10",
      hash: "0xaa",
      parentHash: "0xa9",
      extrinsicsRoot: "0xee",
      stateRoot: "0xff",
    };
    c.emitFinalized(h);
    expect(received).toEqual([h]);
    // emitFinalized also stashes the header so a later getBlockHeader hits.
    const fetched = await c.getBlockHeader("10");
    expect(fetched).toEqual(h);
    unsub();
  });

  test("emits new head to subscribers", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const received: SubstrateHead[] = [];
    await c.subscribeNewHeads((h) => received.push(h));
    c.emitNew({
      number: "11",
      hash: "0xbb",
      parentHash: "0xaa",
      extrinsicsRoot: "0xee",
      stateRoot: "0xff",
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.number).toBe("11");
  });

  test("emits BlockWinner event with miner/energy/submittedAt", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const received: Array<{ miner: string; energyMilli: number; submittedAt: string }> = [];
    await c.subscribeBlockWinnerEvents((e) =>
      received.push({ miner: e.miner, energyMilli: e.energyMilli, submittedAt: e.submittedAt }),
    );
    c.emitBlockWinner({
      miner: "5Grw",
      reward: "1000",
      energyMilli: 12500,
      submittedAt: "42",
    });
    expect(received).toEqual([{ miner: "5Grw", energyMilli: 12500, submittedAt: "42" }]);
  });

  test("connect/disconnect flips isConnected and fires hooks", async () => {
    const c = new FakeSubstrateClient();
    const events: string[] = [];
    c.onConnected(() => events.push("connected"));
    c.onDisconnected(() => events.push("disconnected"));
    expect(c.isConnected()).toBe(false);
    await c.connect();
    expect(c.isConnected()).toBe(true);
    expect(events).toEqual(["connected"]);
    await c.disconnect();
    expect(c.isConnected()).toBe(false);
    expect(events).toEqual(["connected", "disconnected"]);
  });

  test("storage queries return defaults / programmable values", async () => {
    const c = new FakeSubstrateClient();
    expect(await c.getBabeEpoch()).toBeNull();
    expect(await c.getBabeAuthorities()).toEqual([]);
    expect(await c.getChainMiners()).toEqual([]);
    expect(await c.getDifficulty()).toBeNull();
    const rt = await c.getRuntimeVersion();
    expect(rt.specName).toBe("quip");
    expect(rt.specVersion).toBe(101);

    c.babeEpoch = {
      epochIndex: 1,
      currentSlot: "2400",
      epochStartSlot: "2400",
      slotsPerEpoch: 2400,
      authorityCount: 3,
    };
    const e = await c.getBabeEpoch();
    expect(e?.epochIndex).toBe(1);
  });

  test("getBlockHeader returns null for unknown block numbers", async () => {
    const c = new FakeSubstrateClient();
    expect(await c.getBlockHeader("missing")).toBeNull();
  });

  test("subscribeBlockEvents groups events per block", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const seen: BlockEvents[] = [];
    await c.subscribeBlockEvents((e) => {
      seen.push(e);
    });
    c.emitBlock({
      blockNumber: 100,
      blockHash: "0xsub",
      parentHash: "0xsub99",
      author: "5Author",
      timestamp: 1700000000,
      winner: {
        miner: "5GPPxx",
        reward: "1000",
        energyMilli: -2510,
        submittedAt: "100",
      },
      proofs: [
        {
          miner: "5GPPxx",
          energyMilli: -2510,
          diversityMilli: 420,
          validSolutionCount: 5,
          qualityMilli: 850,
        },
      ],
      nonce: "42",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.author).toBe("5Author");
    expect(seen[0]?.winner?.energyMilli).toBe(-2510);
    expect(seen[0]?.proofs).toHaveLength(1);
  });

  test("subscribeBlockEvents still fires when winner is null (authorship-only head)", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    const seen: BlockEvents[] = [];
    await c.subscribeBlockEvents((e) => {
      seen.push(e);
    });
    // No PoW winner this block — author is still recorded.
    c.emitBlock({
      blockNumber: 101,
      blockHash: "0xnowin",
      parentHash: "0xsub",
      author: "5Author",
      timestamp: 1700000006,
      winner: null,
      proofs: [],
      nonce: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.winner).toBeNull();
    expect(seen[0]?.author).toBe("5Author");
  });

  test("getLastProofBlockAt returns programmed value", async () => {
    const c = new FakeSubstrateClient();
    c.lastProofBlockByHash.set("0xsub99", 94);
    expect(await c.getLastProofBlockAt("0xsub99")).toBe(94);
  });

  test("getTopology returns configured nodes/edges", async () => {
    const c = new FakeSubstrateClient();
    c.topology = { nodeCount: 100, edgeCount: 200 };
    expect(await c.getTopology()).toEqual({ nodeCount: 100, edgeCount: 200 });
  });

  test("unsubscribe removes the callback", async () => {
    const c = new FakeSubstrateClient();
    await c.connect();
    let count = 0;
    const unsub = await c.subscribeFinalizedHeads(() => count++);
    c.emitFinalized({
      number: "1",
      hash: "0xa",
      parentHash: "0x0",
      extrinsicsRoot: "0xe",
      stateRoot: "0xs",
    });
    unsub();
    c.emitFinalized({
      number: "2",
      hash: "0xb",
      parentHash: "0xa",
      extrinsicsRoot: "0xe",
      stateRoot: "0xs",
    });
    expect(count).toBe(1);
  });
});

// PolkadotSubstrateClient integration smoke test. Gated behind
// QUIP_TEST_VALIDATOR_RPC_URL so unit-test runs (and CI without a
// validator) don't depend on a live chain. Run locally against the
// nodes.quip.network v0.2 compose:
//   QUIP_TEST_VALIDATOR_RPC_URL=ws://localhost:9944 bun test
const integrationUrl = process.env.QUIP_TEST_VALIDATOR_RPC_URL;
const maybeTest = integrationUrl ? test : test.skip;

describe("PolkadotSubstrateClient (integration)", () => {
  maybeTest(
    "connects, reads runtime version, subscribes, disconnects",
    async () => {
      const client = new PolkadotSubstrateClient(integrationUrl!, 30_000);
      await client.connect();
      expect(client.isConnected()).toBe(true);

      const rt = await client.getRuntimeVersion();
      expect(rt.specName.length).toBeGreaterThan(0);

      // Quick subscription roundtrip — the chain produces ~1 block per 6s
      // on quip-protocol-rs spec 101, so wait up to 10s for one new head.
      const received: SubstrateHead[] = [];
      const unsub = await client.subscribeNewHeads((h) => received.push(h));
      await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      unsub();
      expect(received.length).toBeGreaterThan(0);

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    },
    30_000,
  );
});

// Hand-rolled fixtures shaped like polkadot.js's `getBlock().block.extrinsics`
// — just enough for extractNonce's narrow type assertion. No @polkadot/api
// codec instances needed; the helper only reads via `toString()` and field
// presence checks.
type FakeExtrinsic = {
  isSigned: boolean;
  signer: { toString: () => string };
  method: { section: string; method: string; args: Array<{ toString: () => string }> };
};

function makeSubmitProofExtrinsic(opts: {
  signer: string;
  nonce: string;
  isSigned?: boolean;
  section?: string;
  method?: string;
}): FakeExtrinsic {
  return {
    isSigned: opts.isSigned ?? true,
    signer: { toString: () => opts.signer },
    method: {
      section: opts.section ?? "quantumPow",
      // Polkadot.js exposes runtime call names in camelCase (`submit_proof`
      // in pallet code → `submitProof` from `ext.method.method`).
      method: opts.method ?? "submitProof",
      args: [
        {
          // extractNonce reads `args[0].nonce.toString()`; the codec's own
          // toString is irrelevant but harmless.
          toString: () => "<proof>",
          nonce: { toString: () => opts.nonce },
        } as unknown as { toString: () => string },
      ],
    },
  };
}

function makeSignedBlock(extrinsics: FakeExtrinsic[]): unknown {
  return { block: { extrinsics } };
}

const winnerOf = (miner: string): BlockWinnerEvent => ({
  miner,
  reward: "1000",
  energyMilli: -2510,
  submittedAt: "100",
});

describe("extractNonce", () => {
  test("returns the nonce from the matching signed submitProof extrinsic", () => {
    const signed = makeSignedBlock([makeSubmitProofExtrinsic({ signer: "5GPPxx", nonce: "42" })]);
    expect(extractNonce(signed, winnerOf("5GPPxx"))).toBe("42");
  });

  test("returns null when no extrinsic matches the winner's signer", () => {
    const signed = makeSignedBlock([
      // submit_proof, but from a different miner
      makeSubmitProofExtrinsic({ signer: "5GOther", nonce: "7" }),
      // quantumPow extrinsic of a different method
      makeSubmitProofExtrinsic({
        signer: "5GPPxx",
        nonce: "99",
        method: "register_miner",
      }),
      // unsigned (inherent) extrinsic in the section we care about
      makeSubmitProofExtrinsic({ signer: "5GPPxx", nonce: "1", isSigned: false }),
      // unrelated pallet
      makeSubmitProofExtrinsic({ signer: "5GPPxx", nonce: "2", section: "balances" }),
    ]);
    expect(extractNonce(signed, winnerOf("5GPPxx"))).toBeNull();
  });

  test("returns the first match when the same signer submitted multiple proofs", () => {
    // Chain invariant: only one proof can win per block, but the pallet
    // accepts up to MaxProofsPerBlock submissions from a miner before
    // on_finalize picks the best. The helper documents its first-match
    // behavior so callers know what to expect on this shape.
    const signed = makeSignedBlock([
      makeSubmitProofExtrinsic({ signer: "5GPPxx", nonce: "11" }),
      makeSubmitProofExtrinsic({ signer: "5GPPxx", nonce: "22" }),
      makeSubmitProofExtrinsic({ signer: "5GPPxx", nonce: "33" }),
    ]);
    expect(extractNonce(signed, winnerOf("5GPPxx"))).toBe("11");
  });
});
