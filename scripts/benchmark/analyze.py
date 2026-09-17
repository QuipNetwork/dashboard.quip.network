#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Reduce sampled measurements into the Task 11 assertion record. Consumes:
#   --samples   NDJSON from sampler.py
#   --workload  workload.json (recorded upstream work)
#   --result    output result.json
#
# This is the honest aggregation layer. An assertion is PASS only when its
# supporting evidence was actually measured. Missing, invalid, non-finite,
# or negative data makes the assertion FAIL. A measured real zero is a valid
# value; the absence of a measurement is not treated as zero. A nonexistent
# or zero baseline cannot support a reduction claim and fails. Admitted work,
# silent stalls, and parity are never inferred from absence.

import argparse
import json
import math
import statistics
import sys

# The 512 MiB and 20% targets from the plan use strict inequality; admitted,
# upstream reduction, and stall limits use <= / ==.
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


def _flatten(prefix, value, out):
    """Flatten nested JSON into dot-path leaf keys so progress and health
    payloads are visible to the reducer. None leaf values are dropped."""
    if isinstance(value, dict):
        for k, v in value.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            _flatten(key, v, out)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            key = f"{prefix}.{i}" if prefix else str(i)
            _flatten(key, v, out)
    else:
        if value is not None:
            out[prefix] = value


def flatten(obj):
    out = {}
    _flatten("", obj, out)
    return out


def is_measure(value):
    """A real finite non-boolean number. Non-finite and bool are not
    measurements. None is handled by the caller as missing."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def containers_from(samples):
    """Collect container names from any container metric key present."""
    out = set()
    for s in samples:
        for k in s:
            for suffix in (
                "_memBytes",
                "_rssBytes",
                "_workingSetBytes",
                "_cpuFraction",
            ):
                if k.endswith(suffix):
                    out.add(k[: -len(suffix)])
    return sorted(out)


def per_metric_samples(samples, containers, suffix):
    """Return (totals, seen, invalid) where totals is one combined value per
    sample (sum across all declared containers, only when every container
    contributed a valid non-negative measurement), seen is True when at least
    one container was measured, and invalid is True when a measurement was
    non-finite or negative."""
    totals = []
    seen = False
    invalid = False
    for s in samples:
        vals = {}
        for c in containers:
            v = s.get(f"{c}{suffix}")
            if v is not None:
                seen = True
            vals[c] = v
        bad = [
            v for c, v in vals.items() if v is not None and (not is_measure(v) or v < 0)
        ]
        if bad:
            invalid = True
            continue
        present = [v for v in vals.values() if v is not None]
        if len(present) == len(containers):
            totals.append(sum(vals[c] for c in containers))
    return totals, seen, invalid


def _leaf(key):
    return key.rsplit(".", 1)[-1].lower()


def _stall_truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return False


def reduction(obs, rec, what):
    rec_valid = rec is not None and is_measure(rec) and rec > 0
    obs_valid = obs is not None and is_measure(obs) and obs >= 0
    if not obs_valid:
        return {
            "passed": False,
            "observed": obs,
            "recorded": rec,
            "limit": REDUCTION_LIMIT,
            "detail": f"{what}: observed upstream value missing or invalid ({obs!r})",
        }
    if not rec_valid:
        return {
            "passed": False,
            "observed": obs,
            "recorded": rec,
            "limit": REDUCTION_LIMIT,
            "detail": f"{what}: recorded baseline missing or nonpositive ({rec!r}); cannot claim a reduction",
        }
    ratio = obs / rec
    return {
        "passed": ratio <= REDUCTION_LIMIT,
        "observed": obs,
        "recorded": rec,
        "ratio": round(ratio, 4),
        "limit": REDUCTION_LIMIT,
        "detail": f"{what}: observed {obs} vs recorded {rec} (ratio {ratio:.4f} <= {REDUCTION_LIMIT})",
    }


def compute_assertions(samples, workload, observed_upstream):
    """Build the assertions dict from raw samples and observed upstream."""
    # Flatten every sample so nested progress/health fields are reachable.
    samples = [flatten(s) for s in samples]
    containers = containers_from(samples)

    # Compute both the true-RSS and the working-set series. The RSS assertion
    # uses true process RSS when a runtime exposes it; when every RSS value is
    # unavailable, the working set is a degraded proxy (reported as such).
    rss_totals, rss_seen, rss_invalid = per_metric_samples(
        samples, containers, "_rssBytes"
    )
    ws_totals, ws_seen, _ = per_metric_samples(samples, containers, "_workingSetBytes")
    using_working_set = (not rss_seen or not rss_totals) and ws_seen and ws_totals
    if rss_invalid:
        rss = {
            "passed": False,
            "observedMiB": None,
            "observedBytes": None,
            "limitMiB": RSS_LIMIT_MIB,
            "detail": "rss: non-finite or negative resident-memory measurement",
        }
    elif (not rss_seen or not rss_totals) and not using_working_set:
        rss = {
            "passed": False,
            "observedMiB": None,
            "observedBytes": None,
            "limitMiB": RSS_LIMIT_MIB,
            "detail": (
                "rss: no resident-memory evidence supplied; true RSS unavailable "
                "and no working set present"
            ),
        }
    elif using_working_set:
        peak_bytes = max(ws_totals)
        rss_mib = peak_bytes / MIB
        rss = {
            "passed": rss_mib < RSS_LIMIT_MIB,
            "observedMiB": round(rss_mib, 2),
            "observedBytes": round(peak_bytes),
            "limitMiB": RSS_LIMIT_MIB,
            "detail": (
                f"peak working-set (RSS unavailable) {rss_mib:.2f} MiB "
                f"< {RSS_LIMIT_MIB} MiB"
            ),
        }
    else:
        peak_bytes = max(rss_totals)
        rss_mib = peak_bytes / MIB
        rss = {
            "passed": rss_mib < RSS_LIMIT_MIB,
            "observedMiB": round(rss_mib, 2),
            "observedBytes": round(peak_bytes),
            "limitMiB": RSS_LIMIT_MIB,
            "detail": f"peak combined-image RSS {rss_mib:.2f} MiB < {RSS_LIMIT_MIB} MiB",
        }

    cpu_totals, cpu_seen, cpu_invalid = per_metric_samples(
        samples, containers, "_cpuFraction"
    )
    if cpu_invalid:
        cpu = {
            "passed": False,
            "observedFraction": None,
            "limit": CPU_LIMIT,
            "detail": "cpu: non-finite or negative CPU measurement",
        }
    elif not cpu_seen or not cpu_totals:
        cpu = {
            "passed": False,
            "observedFraction": None,
            "limit": CPU_LIMIT,
            "detail": "cpu: no CPU evidence supplied",
        }
    else:
        cpu_avg = statistics.mean(cpu_totals)
        cpu = {
            "passed": cpu_avg < CPU_LIMIT,
            "observedFraction": round(cpu_avg, 4),
            "limit": CPU_LIMIT,
            "detail": f"average combined-image CPU {cpu_avg:.4f} < {CPU_LIMIT} core",
        }

    # Admitted work: only from an explicitly reported progress field. A real
    # zero is valid; no field at all is missing evidence.
    admitted_seen = False
    admitted_invalid = False
    admitted_values = []
    stall_seen = False
    stalls = 0
    for s in samples:
        for key, val in s.items():
            leaf = _leaf(key)
            if "admitted" in leaf:
                admitted_seen = True
                if is_measure(val) and val >= 0:
                    admitted_values.append(val)
                else:
                    admitted_invalid = True
            if "stall" in leaf:
                stall_seen = True
                if _stall_truthy(val):
                    stalls += 1

    if admitted_invalid:
        max_admitted = None
        admitted_passed = False
        admitted_detail = "maxAdmitted: non-finite or negative progress value"
    elif not admitted_seen:
        max_admitted = None
        admitted_passed = False
        admitted_detail = "maxAdmitted: no progress evidence supplied"
    else:
        max_admitted = max(admitted_values)
        admitted_passed = max_admitted <= ADMITTED_LIMIT
        admitted_detail = f"max admitted work {max_admitted} <= {ADMITTED_LIMIT}"
    admitted = {
        "passed": admitted_passed,
        "observed": max_admitted,
        "limit": ADMITTED_LIMIT,
        "detail": admitted_detail,
    }

    if not stall_seen:
        stall_passed = False
        stall_detail = (
            "silentStalls: no stall indicator supplied; cannot claim zero stalls"
        )
    else:
        stall_passed = stalls == 0
        stall_detail = f"silent indexing stalls {stalls} == 0"
    silent = {
        "passed": stall_passed,
        "observed": stalls,
        "limit": STALL_LIMIT,
        "detail": stall_detail,
    }

    # Parity must be explicitly verified in the observed upstream evidence.
    parity_true = observed_upstream.get("parity") is True
    parity = {
        "passed": parity_true,
        "detail": (
            "logical parity with recorded responses explicitly verified"
            if parity_true
            else "parity evidence not supplied or not verified"
        ),
    }

    recorded = (workload or {}).get("totals", {}) or {}
    call_reduction = reduction(
        observed_upstream.get("calls"), recorded.get("calls"), "upstream calls"
    )
    byte_reduction = reduction(
        observed_upstream.get("responseBytes"),
        recorded.get("responseBytes"),
        "upstream response bytes",
    )

    return {
        "parity": parity,
        "maxAdmitted": admitted,
        "upstreamCallReduction": call_reduction,
        "upstreamByteReduction": byte_reduction,
        "rss": rss,
        "cpu": cpu,
        "silentStalls": silent,
    }


def failing_all(reason):
    """Build an assertion record where every assertion fails because the
    inputs could not be read at all (for example malformed JSON)."""
    return {
        key: {
            "passed": False,
            "detail": f"cannot read inputs: {reason}",
        }
        for key in ASSERTION_KEYS
    }


def load_ndjson(path):
    out = []
    with open(path) as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno}: malformed sample JSON: {exc}")
    return out


def write_result(path, result):
    with open(path, "w") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", required=True)
    ap.add_argument("--workload", required=True)
    ap.add_argument("--result", required=True)
    ap.add_argument("--observed-upstream", default="{}")
    ap.add_argument("--meta", default="{}")
    args = ap.parse_args()

    try:
        with open(args.workload) as fh:
            workload = json.load(fh)
        samples = load_ndjson(args.samples)
        observed = json.loads(args.observed_upstream) if args.observed_upstream else {}
        meta = json.loads(args.meta) if args.meta else {}
        assertions = compute_assertions(samples, workload, observed)
        result = {"meta": meta, "assertions": assertions}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"meta": {}, "assertions": failing_all(str(exc))}

    write_result(args.result, result)
    passed = all(a.get("passed", False) for a in result["assertions"].values())
    sys.stdout.write("ANALYZE RESULT: %s\n" % ("PASS" if passed else "FAIL"))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
