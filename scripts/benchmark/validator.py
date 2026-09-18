#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Validate a benchmark result file against the Task 11 assertions.
#
#   python3 scripts/benchmark/validator.py result.json [--candidate NAME...] [--baseline NAME...]
#
# Exit code 0 when every assertion passes, 1 otherwise. The validator does not
# trust a passed:true boolean by itself: it re-checks every observed value
# against the plan's fixed limit and requires that explicit baseline and
# candidate groups were declared for any comparison. A forged passed:true on
# an over-budget observation therefore fails. Missing, invalid, non-finite,
# or negative evidence fails. A measured real zero passes; an absent baseline
# fails. Parity, admitted work, and silent stalls are never inferred from
# absence.
#
# The result file is written by analyze.py and has the shape:
#
# {
#   "meta": { "baseline": [...], "candidate": [...] },
#   "assertions": {
#     "parity":                { "passed": bool, "detail": str },
#     "maxAdmitted":           { "passed": bool, "observed": int, "limit": 64 },
#     "upstreamCallReduction": { "passed": bool, "observed": int, "recorded": int, "ratio": float, "limit": 0.50 },
#     "upstreamByteReduction": { "passed": bool, "observed": int, "recorded": int, "ratio": float, "limit": 0.50 },
#     "rss":                   { "passed": bool, "observedMiB": float, "limitMiB": 512 },
#     "cpu":                   { "passed": bool, "observedFraction": float, "limit": 0.20 },
#     "silentStalls":          { "passed": bool, "observed": int, "limit": 0 }
#   }
# }
#
# A comparison proved on observed data requires the meta block to name the
# baseline and candidate groups (the recorded baseline and the new system).
# This is the Task 11 "matched baseline" contract: a comparison without an
# explicit baseline group cannot be validated as a reduction.

import argparse
import json
import math
import sys

RSS_LIMIT_MIB = 512.0
CPU_LIMIT = 0.20
ADMITTED_LIMIT = 64
REDUCTION_LIMIT = 0.50
STALL_LIMIT = 0
MIB = 1024 * 1024

ASSERTION_KEYS = (
    "parity",
    "maxAdmitted",
    "upstreamCallReduction",
    "upstreamByteReduction",
    "rss",
    "cpu",
    "silentStalls",
)


def fail(msg):
    sys.stderr.write(f"VALIDATOR FAIL: {msg}\n")
    return 1


def is_measure(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def check_parity(entry):
    if not isinstance(entry, dict) or entry.get("passed") is not True:
        return "parity not verified; evidence must be supplied explicitly"
    return None


def check_max_admitted(entry):
    if not isinstance(entry, dict):
        return "maxAdmitted: missing assertion entry"
    # Limit must be present and inside the fixed cap. A forged pass with an
    # over-limit observed value is detected by the observed <= limit check.
    limit = entry.get("limit")
    observed = entry.get("observed")
    if not is_measure(limit) or limit > ADMITTED_LIMIT:
        return f"maxAdmitted: limit {limit!r} exceeds hard cap {ADMITTED_LIMIT}"
    if observed is None:
        # A real zero is a valid measurement; None means no evidence.
        return "maxAdmitted: no observed value supplied"
    if not is_measure(observed) or observed < 0:
        return f"maxAdmitted: invalid observed value {observed!r}"
    if observed > limit:
        return f"maxAdmitted: observed {observed} exceeds limit {limit}"
    return None


def check_rss(entry):
    if not isinstance(entry, dict):
        return "rss: missing assertion entry"
    limit = entry.get("limitMiB")
    observed = entry.get("observedMiB")
    if not is_measure(limit) or limit > RSS_LIMIT_MIB:
        return f"rss: limitMiB {limit!r} exceeds hard cap {RSS_LIMIT_MIB}"
    if observed is None:
        return "rss: no observed value supplied"
    if not is_measure(observed) or observed < 0:
        return f"rss: invalid observed value {observed!r}"
    if not (observed < limit):
        return f"rss: observed {observed} MiB not below limit {limit} MiB"
    return None


def check_cpu(entry):
    if not isinstance(entry, dict):
        return "cpu: missing assertion entry"
    limit = entry.get("limit")
    observed = entry.get("observedFraction")
    if not is_measure(limit) or limit > CPU_LIMIT:
        return f"cpu: limit {limit!r} exceeds hard cap {CPU_LIMIT}"
    if observed is None:
        return "cpu: no observed value supplied"
    if not is_measure(observed) or observed < 0:
        return f"cpu: invalid observed value {observed!r}"
    if not (observed < limit):
        return f"cpu: observed {observed} fraction not below limit {limit} fraction"
    return None


def check_reduction(key, entry, is_bytes):
    label = "upstream bytes" if is_bytes else "upstream calls"
    if not isinstance(entry, dict):
        return f"{key}: missing assertion entry"
    limit = entry.get("limit")
    if not is_measure(limit) or limit > REDUCTION_LIMIT:
        return f"{key}: limit {limit!r} exceeds hard cap {REDUCTION_LIMIT}"
    observed = entry.get("observed")
    recorded = entry.get("recorded")
    if observed is None or not is_measure(observed) or observed < 0:
        return f"{key}: observed {label} missing or invalid ({observed!r})"
    if recorded is None or not is_measure(recorded) or recorded <= 0:
        return f"{key}: recorded {label} baseline missing or nonpositive ({recorded!r})"
    ratio = observed / recorded
    if ratio > limit:
        return f"{key}: {label} ratio {ratio:.4f} exceeds limit {limit}"
    return None


def check_silent_stalls(entry):
    if not isinstance(entry, dict):
        return "silentStalls: missing assertion entry"
    limit = entry.get("limit")
    if not is_measure(limit) or limit > STALL_LIMIT:
        return f"silentStalls: limit {limit!r} exceeds hard cap {STALL_LIMIT}"
    observed = entry.get("observed")
    if observed is None:
        return "silentStalls: no stall evidence supplied; cannot claim zero stalls"
    if not is_measure(observed) or observed < 0:
        return f"silentStalls: invalid observed value {observed!r}"
    if observed > limit:
        return f"silentStalls: observed {observed} exceeds limit {limit}"
    return None


def check_explicit_groups(meta):
    """A reduction comparison needs an explicit baseline and candidate group.
    Individual resource measurements do not require a baseline. Return an
    error string or None."""
    baseline = meta.get("baseline")
    candidate = meta.get("candidate")
    if not baseline or not candidate:
        return (
            "meta.baseline and meta.candidate groups required for the upstream "
            "reduction comparison; a matched baseline must be named"
        )
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("result")
    args = ap.parse_args()

    try:
        with open(args.result) as fh:
            result = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        return fail(f"cannot read result file: {exc}")

    if not isinstance(result, dict):
        return fail("result file is not a JSON object")
    assertions = result.get("assertions", {})
    meta = result.get("meta", {}) or {}
    passed = True
    checkers = {
        "parity": check_parity,
        "maxAdmitted": check_max_admitted,
        "upstreamCallReduction": lambda e: check_reduction(
            "upstreamCallReduction", e, False
        ),
        "upstreamByteReduction": lambda e: check_reduction(
            "upstreamByteReduction", e, True
        ),
        "rss": check_rss,
        "cpu": check_cpu,
        "silentStalls": check_silent_stalls,
    }

    for key in ASSERTION_KEYS:
        entry = assertions.get(key)
        error = checkers[key](entry)
        if error:
            passed = False
            print(f"[FAIL] {key}: {error}")
        else:
            print(f"[PASS] {key}: {entry.get('detail', '')}")

    groups_error = check_explicit_groups(meta)
    if groups_error:
        passed = False
        print(f"[FAIL] groups: {groups_error}")

    print("RESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
