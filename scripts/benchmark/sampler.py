#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sample a running container for working-set memory, true process RSS, CPU,
# and optional HTTP endpoints, writing measurement records as NDJSON. Run
# under the benchmark runner:
#
#   python3 scripts/benchmark/sampler.py \
#     --containers baseline new \
#     --health http://127.0.0.1:3001/api/health \
#     --interval 2 --duration 30 \
#     --out build/samples.jsonl
#
# Measurements are recorded honestly, labelled by what was actually read:
#   {container}_workingSetBytes  Docker working-set memory from MemoryStats
#   {container}_rssBytes         True resident process memory from
#                                MemoryStats.stats (rss / total_rss); None
#                                when the runtime does not expose it
#   {container}_cpuFraction      Docker CPU share of one core
#
# The working set is NOT recorded as RSS. True RSS is recorded separately and
# marked unavailable (None) when a runtime does not expose it, so downstream
# reduction can distinguish an absent RSS value from a real zero. Records are
# streamed to the output file one line per sample, and flushed after each
# interval so a long soak shows progress and partial output survives.

import argparse
import json
import math
import subprocess
import sys
import time
import urllib.request


def now_ms():
    return int(time.time() * 1000)


def _docker(args, timeout=10):
    try:
        out = subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.SubprocessError, FileNotFoundError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def _positive_number(ap, name, raw):
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        ap.error(f"{name} must be a number")
    if not math.isfinite(value) or value <= 0:
        ap.error(f"{name} must be a positive finite number")
    return value


def docker_mem(container):
    """Return (working_set_bytes, rss_bytes) from docker inspect MemoryStats.

    working_set_bytes is the usage the runtime reports (approximates the
    working set including page cache). rss_bytes is the true resident process
    memory from the stats map when present, otherwise None. Any parse or
    runtime failure returns (None, None) so no value is fabricated."""
    raw = _docker(
        [
            "inspect",
            "--format",
            "{{json .MemoryStats}}",
            container,
        ]
    )
    if not raw:
        return None, None
    try:
        stats = json.loads(raw)
    except json.JSONDecodeError:
        return None, None
    usage = stats.get("usage")
    try:
        ws = int(usage) if usage is not None else None
    except (TypeError, ValueError):
        ws = None
    rss = None
    nested = stats.get("stats") or {}
    for key in ("rss", "total_rss"):
        value = nested.get(key)
        if value is not None:
            try:
                rss = int(value)
                break
            except (TypeError, ValueError):
                continue
    return ws, rss


def docker_cpu(container):
    """Return the CPU share of one core as a fraction in [0, inf), or None
    when the runtime reports no value. A real zero CPU is a valid measurement
    and is returned as 0.0."""
    raw = _docker(
        [
            "stats",
            "--no-stream",
            "--format",
            "{{.Name}}\t{{.CPUPerc}}",
            container,
        ]
    )
    if not raw:
        return None
    fields = raw.split("\t")
    if len(fields) < 2:
        return None
    cpu_text = fields[1].strip().rstrip("%")
    if not cpu_text:
        return None
    try:
        fraction = float(cpu_text) / 100.0
    except ValueError:
        return None
    return fraction


def fetch_json(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001 - record any poll failure
        return {"_error": str(exc)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--containers", nargs="+", required=True)
    ap.add_argument("--health", nargs="*", default=[])
    ap.add_argument("--progress", nargs="*", default=[])
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--duration", type=float, default=30.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    interval = _positive_number(ap, "interval", args.interval) or 2.0
    duration = _positive_number(ap, "duration", args.duration)

    start = time.monotonic()
    deadline = start + duration
    first = True
    with open(args.out, "w") as fh:
        while time.monotonic() < deadline:
            ts = now_ms()
            rec = {"tsMs": ts}
            for container in args.containers:
                ws, rss = docker_mem(container)
                cpu = docker_cpu(container)
                rec[f"{container}_workingSetBytes"] = ws
                rec[f"{container}_rssBytes"] = rss
                rec[f"{container}_cpuFraction"] = cpu
            for url in args.health:
                rec[f"health_{url}"] = fetch_json(url)
            for url in args.progress:
                rec[f"progress_{url}"] = fetch_json(url)
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            if first:
                sys.stdout.write(f"sampler started: writing to {args.out}\n")
                sys.stdout.flush()
                first = False
            time.sleep(interval)
        count = 0
        with open(args.out) as count_fh:
            for _ in count_fh:
                count += 1
        sys.stdout.write(f"wrote {count} samples to {args.out}\n")


if __name__ == "__main__":
    main()
