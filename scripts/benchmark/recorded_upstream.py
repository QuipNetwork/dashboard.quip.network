#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Compute the recorded upstream workload (method calls and response bytes)
# from the recorded chain fixture. This is the honest quantitative basis for
# the upstream comparison: it is derived from the recorded real-chain
# provenance (chain_getBlock, state_getMetadata, etc.), not fabricated.
#
# The miner seed REST rules are NOT counted as validator upstream calls: they
# are local HTTP requests to the miner, not method calls forwarded to the
# validator over the chain transport. The workload profile (workload.mjs)
# records them separately so the network volume is visible, but the validator
# upstream comparison uses the chain-provenance method calls only. A missing
# provenance fixture yields an explicit error rather than a silent zero total,
# because a zero baseline cannot support a reduction claim.

import json
import os
import sys


def load_recorded_upstream(fixture_dir):
    """Return a dict of totals {calls, responseBytes} for one recorded input
    unit (one valid block) from the chain-live provenance."""
    chain_live = os.path.join(fixture_dir, "chain-live", "provenance.json")
    if not os.path.exists(chain_live):
        raise FileNotFoundError(f"missing recorded provenance: {chain_live}")
    with open(chain_live) as fh:
        prov = json.load(fh)
    calls = prov.get("calls") or []
    if not isinstance(calls, list) or not calls:
        raise ValueError("provenance.calls must be a non-empty array")
    totals = {"calls": 0, "responseBytes": 0}
    for call in calls:
        totals["calls"] += 1
        totals["responseBytes"] += int(call.get("responseBytes", 0))
    return totals


def main():
    fixture_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    try:
        totals = load_recorded_upstream(fixture_dir)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"recorded_upstream: error: {exc}\n")
        return 1
    print(json.dumps(totals, indent=2))
    print(
        f"recorded upstream calls={totals['calls']} "
        f"responseBytes={totals['responseBytes']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
