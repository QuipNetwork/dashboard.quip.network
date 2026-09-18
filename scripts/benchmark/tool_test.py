#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Self-verification for the benchmark measurement/validation tools. Proves:
#   - missing, invalid, non-finite, and negative evidence FAIL
#   - a measured real zero is valid
#   - an absent recorded baseline FAILS a reduction claim
#   - a forged "passed":true on an over-budget observation FAILS
#   - malformed JSON and empty samples FAIL
#   - the analyzer computes PASSING assertions for an in-budget run
#
# The validator distrusts the passed boolean and re-checks every observed
# value (and the fixed limits). Comparison assertions need the explicit
# baseline and candidate groups. Parity, admitted work, and silent stalls are
# never inferred from absence.
#
# Run from the repository root:
#   python3 scripts/benchmark/tool_test.py

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VALIDATOR = os.path.join(ROOT, "scripts", "benchmark", "validator.py")
ANALYZER = os.path.join(ROOT, "scripts", "benchmark", "analyze.py")
SAMPLER = os.path.join(ROOT, "scripts", "benchmark", "sampler.py")
WORKLOAD_MJS = os.path.join(ROOT, "scripts", "benchmark", "workload.mjs")
SCHEDULE_MJS = os.path.join(ROOT, "scripts", "benchmark", "schedule.mjs")
FIXTURES = os.path.join(ROOT, "scripts", "benchmark", "testdata", "fixtures")


def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def run_v(result_path, *extra):
    return run([sys.executable, VALIDATOR, result_path, *extra])


def good_assertions():
    return {
        "parity": {"passed": True, "detail": "parity explicitly verified"},
        "maxAdmitted": {"passed": True, "observed": 12, "limit": 64, "detail": "ok"},
        "upstreamCallReduction": {
            "passed": True,
            "observed": 10,
            "recorded": 100,
            "ratio": 0.1,
            "limit": 0.50,
            "detail": "ok",
        },
        "upstreamByteReduction": {
            "passed": True,
            "observed": 10000,
            "recorded": 100000,
            "ratio": 0.1,
            "limit": 0.50,
            "detail": "ok",
        },
        "rss": {"passed": True, "observedMiB": 100.0, "limitMiB": 512, "detail": "ok"},
        "cpu": {
            "passed": True,
            "observedFraction": 0.05,
            "limit": 0.20,
            "detail": "ok",
        },
        "silentStalls": {"passed": True, "observed": 0, "limit": 0, "detail": "ok"},
    }


def good_meta():
    return {"baseline": ["baseline"], "candidate": ["new"]}


def make_result(tmp, name, assertions, meta=None):
    path = os.path.join(tmp, name)
    with open(path, "w") as fh:
        json.dump({"meta": meta or {}, "assertions": assertions}, fh)
    return path


def main():
    passed = True

    def check(name, cond, detail=""):
        nonlocal passed
        if not cond:
            passed = False
            print(f"[FAIL] {name}: {detail}")
        else:
            print(f"[PASS] {name}")

    with tempfile.TemporaryDirectory() as tmp:
        # --- Baseline: a valid in-budget run passes ---
        good_path = make_result(tmp, "good.json", good_assertions(), good_meta())
        rc, out, err = run_v(good_path)
        check("validator passes valid in-budget run", rc == 0, out + err)

        # --- Missing/invalid/non-finite/negative evidence ---
        # Missing single assertion entry.
        a = good_assertions()
        del a["rss"]
        p = make_result(tmp, "missing-assert.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails missing assertion entry", rc == 1, out)
        # Missing observed value (key present, observed absent).
        a = good_assertions()
        del a["rss"]["observedMiB"]
        a["rss"]["passed"] = True
        p = make_result(tmp, "missing-observed.json", a, good_meta())
        rc, out, _ = run_v(p)
        check(
            "validator fails missing observed value despite passed:true", rc == 1, out
        )
        # Non-finite observed.
        a = good_assertions()
        a["cpu"] = {
            "passed": True,
            "observedFraction": float("nan"),
            "limit": 0.20,
            "detail": "nan",
        }
        p = make_result(tmp, "nan.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails non-finite (NaN) observed", rc == 1, out)
        a = good_assertions()
        a["cpu"] = {
            "passed": True,
            "observedFraction": float("inf"),
            "limit": 0.20,
            "detail": "inf",
        }
        p = make_result(tmp, "inf.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails infinite observed", rc == 1, out)
        # Negative observed.
        a = good_assertions()
        a["rss"] = {
            "passed": True,
            "observedMiB": -5.0,
            "limitMiB": 512,
            "detail": "neg",
        }
        p = make_result(tmp, "neg.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails negative observed", rc == 1, out)

        # --- Measured real zeros are valid ---
        a = good_assertions()
        a["cpu"] = {
            "passed": True,
            "observedFraction": 0.0,
            "limit": 0.20,
            "detail": "zero",
        }
        a["silentStalls"] = {
            "passed": True,
            "observed": 0,
            "limit": 0,
            "detail": "zero",
        }
        a["maxAdmitted"] = {
            "passed": True,
            "observed": 0,
            "limit": 64,
            "detail": "zero",
        }
        a["parity"] = {"passed": True, "detail": "verified"}
        p = make_result(tmp, "zeros.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator accepts real zero observations", rc == 0, out)

        # --- Absent baseline FAILS a reduction ---
        a = good_assertions()
        del a["upstreamCallReduction"]["recorded"]
        a["upstreamCallReduction"]["passed"] = True
        p = make_result(tmp, "no-recorded.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails reduction with absent recorded baseline", rc == 1, out)
        a = good_assertions()
        a["upstreamCallReduction"]["recorded"] = 0
        a["upstreamCallReduction"]["ratio"] = 0.0
        a["upstreamCallReduction"]["passed"] = True
        p = make_result(tmp, "zero-recorded.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails reduction with zero recorded baseline", rc == 1, out)

        # --- Forged passed:true overbudget FAILS ---
        a = good_assertions()
        a["maxAdmitted"] = {
            "passed": True,
            "observed": 200,
            "limit": 64,
            "detail": "forged",
        }
        p = make_result(tmp, "forged-admitted.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator rejects forged passed:true overbudget admitted", rc == 1, out)
        a = good_assertions()
        a["rss"] = {
            "passed": True,
            "observedMiB": 900.0,
            "limitMiB": 512,
            "detail": "forged",
        }
        p = make_result(tmp, "forged-rss.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator rejects forged passed:true overbudget rss", rc == 1, out)
        a = good_assertions()
        a["cpu"] = {
            "passed": True,
            "observedFraction": 0.8,
            "limit": 0.20,
            "detail": "forged",
        }
        p = make_result(tmp, "forged-cpu.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator rejects forged passed:true overbudget cpu", rc == 1, out)
        a = good_assertions()
        a["upstreamCallReduction"] = {
            "passed": True,
            "observed": 90,
            "recorded": 100,
            "ratio": 0.9,
            "limit": 0.50,
            "detail": "forged",
        }
        p = make_result(tmp, "forged-reduction.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator rejects forged passed:true overbudget reduction", rc == 1, out)

        # --- Silence / parity / admitted never inferred from absence ---
        a = good_assertions()
        a["parity"] = {"passed": False, "detail": "not verified"}
        p = make_result(tmp, "no-parity.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails parity not verified", rc == 1, out)
        a = good_assertions()
        a["silentStalls"] = {"passed": True, "limit": 0, "detail": "nothing"}
        p = make_result(tmp, "no-stall-evidence.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails silent stalls without observed evidence", rc == 1, out)
        a = good_assertions()
        a["maxAdmitted"] = {"passed": True, "limit": 64, "detail": "nothing"}
        p = make_result(tmp, "no-admitted-evidence.json", a, good_meta())
        rc, out, _ = run_v(p)
        check("validator fails admitted work without observed evidence", rc == 1, out)

        # --- Explicit baseline and candidate groups required for comparison ---
        p = make_result(tmp, "no-groups.json", good_assertions(), {})
        rc, out, _ = run_v(p)
        check(
            "validator fails without explicit baseline/candidate groups", rc == 1, out
        )

        # --- Malformed / empty / missing result files ---
        malformed = os.path.join(tmp, "malformed.json")
        with open(malformed, "w") as fh:
            fh.write("{not valid json")
        rc, out, _ = run_v(malformed)
        check("validator fails malformed result JSON", rc == 1, out)
        rc, out, _ = run_v(os.path.join(tmp, "does-not-exist.json"))
        check("validator fails missing result file", rc == 1, out)

        # === Analyzer path ===
        workload = {
            "totals": {"calls": 100, "responseBytes": 100000, "callBytes": 1000}
        }
        wl_path = os.path.join(tmp, "workload.json")
        with open(wl_path, "w") as fh:
            json.dump(workload, fh)
        meta = json.dumps(good_meta())
        # Candidate-only progress evidence in nested payload.
        ok_samples = os.path.join(tmp, "ok-samples.jsonl")
        with open(ok_samples, "w") as fh:
            fh.write(
                json.dumps(
                    {
                        "baseline_workingSetBytes": 300 * 1024 * 1024,
                        "baseline_rssBytes": 280 * 1024 * 1024,
                        "baseline_cpuFraction": 0.05,
                        "new_workingSetBytes": 50 * 1024 * 1024,
                        "new_rssBytes": 40 * 1024 * 1024,
                        "new_cpuFraction": 0.05,
                        "progress": {"admitted": 12, "stall": False},
                    }
                )
                + "\n"
            )
            fh.write(
                json.dumps(
                    {
                        "baseline_workingSetBytes": 400 * 1024 * 1024,
                        "baseline_rssBytes": 380 * 1024 * 1024,
                        "baseline_cpuFraction": 0.05,
                        "new_workingSetBytes": 60 * 1024 * 1024,
                        "new_rssBytes": 50 * 1024 * 1024,
                        "new_cpuFraction": 0.05,
                        "progress": {"admitted": 14, "stall": False},
                    }
                )
                + "\n"
            )

        def analyze(samples, observed, outname):
            result = os.path.join(tmp, outname)
            rc, out, err = run(
                [
                    sys.executable,
                    ANALYZER,
                    "--samples",
                    samples,
                    "--workload",
                    wl_path,
                    "--result",
                    result,
                    "--observed-upstream",
                    json.dumps(observed),
                    "--meta",
                    meta,
                ]
            )
            return rc, out, err, result

        # In-budget run: candidate alone under limits, zero stalls, parity true.
        observed = {"calls": 10, "responseBytes": 10000, "parity": True}
        rc, out, _, result = analyze(ok_samples, observed, "analyzed-ok.json")
        with open(result) as fh:
            analyzed = json.load(fh)
        check(
            "analyzer passes in-budget candidate run",
            rc == 0 and all(a.get("passed") for a in analyzed["assertions"].values()),
            out,
        )

        # Over-budget run: FAILs and validator also rejects it.
        over = {"calls": 80, "responseBytes": 80000, "parity": True}
        rc, out, _, result = analyze(ok_samples, over, "analyzed-over.json")
        with open(result) as fh:
            analyzed = json.load(fh)
        check(
            "analyzer marks over-budget upstream as FAIL",
            rc == 1 and not analyzed["assertions"]["upstreamCallReduction"]["passed"],
            out,
        )
        rc, out, _ = run_v(result)
        check("validator rejects analyzer over-budget result", rc == 1, out)

        # Missing evidence: no RSS values, no progress, no parity. Must FAIL.
        missing_samples = os.path.join(tmp, "missing-samples.jsonl")
        with open(missing_samples, "w") as fh:
            fh.write(json.dumps({"other": 1}) + "\n")
        rc, out, _, result = analyze(missing_samples, {}, "analyzed-missing.json")
        with open(result) as fh:
            analyzed = json.load(fh)
        for key in ("rss", "cpu", "maxAdmitted", "silentStalls"):
            check(
                f"analyzer FAILs {key} with missing evidence",
                analyzed["assertions"][key]["passed"] is False,
                out,
            )
        check(
            "analyzer FAILs parity with no evidence",
            analyzed["assertions"]["parity"]["passed"] is False,
        )
        check(
            "analyzer FAILs absent candidate/baseline upstream",
            analyzed["assertions"]["upstreamCallReduction"]["passed"] is False,
        )

        # Malformed sample JSON: analyzer must write a failing result and exit 1.
        malformed_samples = os.path.join(tmp, "malformed-samples.jsonl")
        with open(malformed_samples, "w") as fh:
            fh.write("{oops\n")
        rc, out, _, result = analyze(malformed_samples, {}, "analyzed-malformed.json")
        with open(result) as fh:
            analyzed = json.load(fh)
        check(
            "analyzer FAILs malformed sample JSON",
            rc == 1
            and all(not a.get("passed") for a in analyzed["assertions"].values()),
            out,
        )

        # Empty samples: no evidence at all -> FAIL, not pass.
        empty_samples = os.path.join(tmp, "empty-samples.jsonl")
        with open(empty_samples, "w") as fh:
            fh.write("")
        rc, out, _, result = analyze(empty_samples, {}, "analyzed-empty.json")
        with open(result) as fh:
            analyzed = json.load(fh)
        check("analyzer FAILs empty samples (no evidence)", rc == 1, out)

        # Non-finite and negative measurements FAIL, real zeros valid.
        bad_samples = os.path.join(tmp, "bad-samples.jsonl")
        with open(bad_samples, "w") as fh:
            fh.write(
                json.dumps(
                    {
                        "new_workingSetBytes": -100,
                        "new_rssBytes": float("nan"),
                        "new_cpuFraction": 0.01,
                        "progress": {"admitted": float("inf"), "stall": False},
                    }
                )
                + "\n"
            )
        rc, out, _, result = analyze(bad_samples, {"parity": True}, "analyzed-bad.json")
        with open(result) as fh:
            analyzed = json.load(fh)
        check(
            "analyzer FAILs non-finite/negative RSS and admitted",
            analyzed["assertions"]["rss"]["passed"] is False,
            out,
        )
        # Real zero for CPU is a valid value.
        zero_samples = os.path.join(tmp, "zero-samples.jsonl")
        with open(zero_samples, "w") as fh:
            fh.write(
                json.dumps(
                    {
                        "new_workingSetBytes": 1024,
                        "new_rssBytes": 1024,
                        "new_cpuFraction": 0.0,
                        "progress": {"admitted": 0, "stall": False},
                    }
                )
                + "\n"
            )
        rc, out, _, result = analyze(
            zero_samples,
            {"parity": True, "calls": 10, "responseBytes": 10000},
            "analyzed-zero.json",
        )
        with open(result) as fh:
            analyzed = json.load(fh)
        check(
            "analyzer accepts real zero CPU/stalls/admitted",
            rc == 0
            and analyzed["assertions"]["cpu"]["observedFraction"] == 0.0
            and analyzed["assertions"]["silentStalls"]["observed"] == 0,
            out,
        )

        # === Workload / schedule deterministic node tools ===
        wl_out = os.path.join(tmp, "workload.json")
        rc, out, _ = run(
            ["node", WORKLOAD_MJS, "--fixtures", FIXTURES, "--out", wl_out]
        )
        check("workload.mjs runs on fixtures", rc == 0, out)
        with open(wl_out) as fh:
            wl = json.load(fh)
        check(
            "workload records chain RPC calls as upstream calls",
            wl["totals"]["calls"] == wl["numRpcCalls"],
            json.dumps(wl["totals"]),
        )
        check(
            "workload separates miner REST calls",
            "minerRestCalls" in wl["totals"] and wl["totals"]["minerRestCalls"] > 0,
        )

        sch_out = os.path.join(tmp, "schedule.json")
        rc1, _, _ = run(
            [
                "node",
                SCHEDULE_MJS,
                "--fixtures",
                FIXTURES,
                "--rate",
                "5",
                "--duration",
                "2",
                "--out",
                sch_out,
            ]
        )
        rc2, _, _ = run(
            [
                "node",
                SCHEDULE_MJS,
                "--fixtures",
                FIXTURES,
                "--rate",
                "5",
                "--duration",
                "2",
                "--out",
                os.path.join(tmp, "schedule2.json"),
            ]
        )
        check("schedule.mjs runs deterministically", rc1 == 0 and rc2 == 0)
        with open(sch_out) as fh:
            s1 = json.load(fh)
        with open(os.path.join(tmp, "schedule2.json")) as fh:
            s2 = json.load(fh)
        check(
            "schedule is byte-identical across runs",
            s1["requests"] == s2["requests"]
            and s1["scheduleHash"] == s2["scheduleHash"],
        )

        # Invalid interval/duration rejected by the sampler argument parser.
        rc, out, err = run(
            [
                sys.executable,
                SAMPLER,
                "--containers",
                "x",
                "--interval",
                "-1",
                "--duration",
                "10",
                "--out",
                os.path.join(tmp, "s.jsonl"),
            ]
        )
        check("sampler rejects negative interval", rc != 0, err)
        rc, out, err = run(
            [
                sys.executable,
                SAMPLER,
                "--containers",
                "x",
                "--interval",
                "nan",
                "--duration",
                "10",
                "--out",
                os.path.join(tmp, "s.jsonl"),
            ]
        )
        check("sampler rejects non-finite interval", rc != 0, err)
        rc, out, err = run(
            [
                sys.executable,
                SAMPLER,
                "--containers",
                "x",
                "--interval",
                "1",
                "--duration",
                "0",
                "--out",
                os.path.join(tmp, "s.jsonl"),
            ]
        )
        check("sampler rejects nonpositive duration", rc != 0, err)
        rc, out, err = run(
            [
                sys.executable,
                SAMPLER,
                "--containers",
                "x",
                "--interval",
                "1",
                "--duration",
                "inf",
                "--out",
                os.path.join(tmp, "s.jsonl"),
            ]
        )
        check("sampler rejects non-finite duration", rc != 0, err)

    print("TOOL TEST RESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
