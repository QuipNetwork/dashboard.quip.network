#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Matched-workload benchmark runner for the Rust dashboard rewrite (Task 11).
#
# Records the same recorded chain/miner inputs and the same HTTP schedule,
# measures baseline and new images, and validates results against the Task 11
# assertions. It never fabricates a comparison: every assertion is computed
# from measured samples and the recorded workload.
#
# Usage:
#   ./scripts/benchmark-dashboard.sh schedule [--rate N] [--duration N] ...
#   ./scripts/benchmark-dashboard.sh sample --baseline NAME --new NAME [flags]
#   ./scripts/benchmark-dashboard.sh analyze --samples FILE --workload FILE ...
#   ./scripts/benchmark-dashboard.sh validate RESULT.json
#   ./scripts/benchmark-dashboard.sh test            # self-verification
#   ./scripts/benchmark-dashboard.sh report          # write performance doc
#
# Subcommands that measure a live target (sample) require the baseline image
# and new image to be built and running. The root owns starting final images;
# this runner consumes them by container name. Six-hour and twenty-four-hour
# soak sampling is supported but must be requested explicitly and is not run
# by default.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$PROJECT_DIR/.." && pwd)"

SCHEDULE="$ROOT_DIR/scripts/benchmark/schedule.mjs"
WORKLOAD="$ROOT_DIR/scripts/benchmark/workload.mjs"
SAMPLER="$ROOT_DIR/scripts/benchmark/sampler.py"
ANALYZER="$ROOT_DIR/scripts/benchmark/analyze.py"
VALIDATOR="$ROOT_DIR/scripts/benchmark/validator.py"
RECORDED_UPSTREAM="$ROOT_DIR/scripts/benchmark/recorded_upstream.py"
TOOL_TEST="$ROOT_DIR/scripts/benchmark/tool_test.py"

FIXTURES="${BENCH_FIXTURES:-$ROOT_DIR/scripts/benchmark/testdata/fixtures}"
BUILD_DIR="${BENCH_BUILD:-$ROOT_DIR/scripts/benchmark/build}"

require() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "error: missing required tool: $1" >&2
		exit 1
	}
}

ensure_build() {
	mkdir -p "$BUILD_DIR"
}

cmd_schedule() {
	require node
	ensure_build
	node "$SCHEDULE" --fixtures "$FIXTURES" \
		--out "$BUILD_DIR/schedule.json" "$@"
}

cmd_workload() {
	require node
	ensure_build
	node "$WORKLOAD" --fixtures "$FIXTURES" \
		--out "$BUILD_DIR/workload.json" "$@"
}

cmd_recorded_upstream() {
	require python3
	python3 "$RECORDED_UPSTREAM" "$FIXTURES"
}

cmd_sample() {
	require python3
	require docker
	ensure_build
	local baseline=""
	local new=""
	local duration=30
	local interval=2
	local out="$BUILD_DIR/samples.jsonl"
	# Remaining args passthrough to sampler.py.
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--baseline)
			baseline="$2"
			shift 2
			;;
		--new)
			new="$2"
			shift 2
			;;
		--duration)
			duration="$2"
			shift 2
			;;
		--interval)
			interval="$2"
			shift 2
			;;
		--out)
			out="$2"
			shift 2
			;;
		*) break ;;
		esac
	done
	if [[ -z "$baseline" && -z "$new" ]]; then
		echo "error: sample requires --baseline and/or --new container names" >&2
		exit 1
	fi
	# Docker is required to read live stats.
	local containers=()
	[[ -n "$baseline" ]] && containers+=("$baseline")
	[[ -n "$new" ]] && containers+=("$new")
	python3 "$SAMPLER" \
		--containers "${containers[@]}" \
		--interval "$interval" --duration "$duration" \
		--out "$out" "$@"
	echo "sampled into $out"
}

cmd_analyze() {
	require python3
	ensure_build
	# Optional flags: --samples, --workload, --result, --observed-upstream, --meta,
	# and the comparison groups --baseline / --candidate.
	local samples="$BUILD_DIR/samples.jsonl"
	local workload="$BUILD_DIR/workload.json"
	local result="$BUILD_DIR/result.json"
	local observed="{}"
	local baseline=""
	local candidate=""
	local meta="{}"
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--samples)
			samples="$2"
			shift 2
			;;
		--workload)
			workload="$2"
			shift 2
			;;
		--result)
			result="$2"
			shift 2
			;;
		--observed-upstream)
			observed="$2"
			shift 2
			;;
		--meta)
			meta="$2"
			shift 2
			;;
		--baseline)
			baseline="$2"
			shift 2
			;;
		--candidate)
			candidate="$2"
			shift 2
			;;
		*)
			echo "error: unknown analyze flag: $1" >&2
			exit 1
			;;
		esac
	done
	# A comparison needs explicit groups. When groups are provided, merge them
	# into the meta block so the validator can demand them.
	local groups="{}"
	if [[ -n "$baseline" || -n "$candidate" ]]; then
		groups="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]);
base=json.loads(sys.argv[2]); cand=json.loads(sys.argv[3])
if base: d["baseline"]=base
if cand: d["candidate"]=cand
print(json.dumps(d))' "$meta" "$baseline" "$candidate")"
		meta="$groups"
	fi
	python3 "$ANALYZER" \
		--samples "$samples" --workload "$workload" \
		--result "$result" --observed-upstream "$observed" \
		--meta "$meta"
	echo "wrote $result"
}

cmd_validate() {
	require python3
	local result="${1:-$BUILD_DIR/result.json}"
	if [[ ! -f "$result" ]]; then
		echo "error: no result file at $result; run analyze first" >&2
		exit 1
	fi
	python3 "$VALIDATOR" "$result"
}

cmd_test() {
	require python3
	python3 "$TOOL_TEST"
}

cmd_soak() {
	# Run a soak sampling pass. Use --seconds or --hours. This just runs the
	# sampler for the requested duration; it does not assume any outcome.
	require python3
	require docker
	ensure_build
	local baseline=""
	local new=""
	local seconds=21600 # 6h default; 24h = 86400
	local interval=30
	local out="$BUILD_DIR/soak-samples.jsonl"
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--baseline)
			baseline="$2"
			shift 2
			;;
		--new)
			new="$2"
			shift 2
			;;
		--seconds)
			seconds="$2"
			shift 2
			;;
		--hours)
			seconds=$(("$2" * 3600))
			shift 2
			;;
		--interval)
			interval="$2"
			shift 2
			;;
		--out)
			out="$2"
			shift 2
			;;
		*)
			echo "error: unknown soak flag: $1" >&2
			exit 1
			;;
		esac
	done
	if [[ -z "$baseline" && -z "$new" ]]; then
		echo "error: soak requires --baseline and/or --new container names" >&2
		exit 1
	fi
	echo "soak: sampling for ${seconds}s at ${interval}s interval into $out"
	local containers=()
	[[ -n "$baseline" ]] && containers+=("$baseline")
	[[ -n "$new" ]] && containers+=("$new")
	python3 "$SAMPLER" \
		--containers "${containers[@]}" \
		--interval "$interval" --duration "$seconds" \
		--out "$out"
	echo "soak samples written to $out"
}

cmd_help() {
	cat <<'EOF'
scripts/benchmark-dashboard.sh — matching benchmark runner for the Rust rewrite

Subcommands:
  schedule        generate the deterministic HTTP schedule from the manifest
  workload        derive the recorded upstream workload from chain fixtures
  recorded-upstream print the recorded upstream call/byte totals
  sample          sample RSS/CPU/health from running baseline/new containers
  analyze         reduce samples into the Task 11 assertion record
  validate        check a result file against the assertions
  test            run the measurement/validation self-verification
  soak            run a long sampling pass (6h/24h) over live containers
  report          (documented; run manually to write docs/rust-dashboard-performance.md)

All measurement values flow from recorded inputs and live samples. No assertion
is fabricated. soak does not wait unless the caller requests hours explicitly.
EOF
}

main() {
	[[ $# -gt 0 ]] || {
		cmd_help
		exit 1
	}
	local cmd="$1"
	shift
	case "$cmd" in
	schedule) cmd_schedule "$@" ;;
	workload) cmd_workload "$@" ;;
	recorded-upstream) cmd_recorded_upstream ;;
	sample) cmd_sample "$@" ;;
	analyze) cmd_analyze "$@" ;;
	validate) cmd_validate "$@" ;;
	test) cmd_test ;;
	soak) cmd_soak "$@" ;;
	help | -h | --help) cmd_help ;;
	*)
		echo "error: unknown command: $cmd" >&2
		cmd_help
		exit 1
		;;
	esac
}

main "$@"
