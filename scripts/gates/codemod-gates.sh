#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork. See LICENSE and FORK.md.
#
# Codemod gate runner: all 4 layers (AD-41, V1-05 4.4).
#
#   Layer 1: grep per specifier + allowlist (platform guard, recount)
#   Layer 2: derivative-pattern grep + import-only diff check
#   Layer 3: lint (.eslintrc.json merged M5 form) + secret scan
#   Layer 4: typecheck + contract suite + smoke (smoke skipped unless
#            --require-smoke; the skip is reported, never hidden)
#
# All selected layers always run, even when an earlier layer fails,
# so one run reports the full state. The summary at the end names
# every layer verdict; exit 0 requires every selected layer to pass.
# A SKIP inside a layer is reported by that layer and counted here;
# it is not a pass and it is never silent.
#
# Usage (from the repo root):
#   sh scripts/gates/codemod-gates.sh [--wave G1|G2|G3|G4|G5|all]
#       [--base <ref>] [--worktree] [--diff-scope import-only|import-and-qualifier]
#       [--files <file>]... [--layers 1,2,3,4] [--require-smoke]
#       [--require-server] [--skip-contract] [--engine-cmd "<command>"]
#
# Examples:
#   sh scripts/gates/codemod-gates.sh
#   sh scripts/gates/codemod-gates.sh --wave G1 --base <trunk-sha>
#   sh scripts/gates/codemod-gates.sh --wave G2 --base <trunk-sha> --require-smoke
#
# Exit 0 only when every selected layer passes. Exit 2 on bad arguments.

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd); fi
cd "$ROOT" || exit 1

WAVE=""
BASE=""
WORKTREE=0
DIFF_SCOPE="import-only"
LAYERS="1,2,3,4"
REQUIRE_SMOKE=0
REQUIRE_SERVER=0
SKIP_CONTRACT=0
ENGINE_CMD=""

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t codemod-gates)
trap 'rm -rf "$tmpdir"' EXIT INT TERM
: > "$tmpdir/files.txt"

while [ $# -gt 0 ]; do
  case "$1" in
    --wave)
      WAVE="$2"
      shift 2
      ;;
    --base)
      BASE="$2"
      shift 2
      ;;
    --worktree)
      WORKTREE=1
      shift
      ;;
    --diff-scope)
      DIFF_SCOPE="$2"
      shift 2
      ;;
    --files)
      echo "$2" >> "$tmpdir/files.txt"
      shift 2
      ;;
    --layers)
      LAYERS="$2"
      shift 2
      ;;
    --require-smoke)
      REQUIRE_SMOKE=1
      shift
      ;;
    --require-server)
      REQUIRE_SERVER=1
      shift
      ;;
    --skip-contract)
      SKIP_CONTRACT=1
      shift
      ;;
    --engine-cmd)
      ENGINE_CMD="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: sh scripts/gates/codemod-gates.sh [--wave G1|G2|G3|G4|G5|all] [--base <ref>] [--worktree] [--diff-scope import-only|import-and-qualifier] [--files <file>]... [--layers 1,2,3,4] [--require-smoke] [--require-server] [--skip-contract] [--engine-cmd \"<command>\"]"
      exit 0
      ;;
    *)
      echo "codemod-gates: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

want_layer() {
  case ",$LAYERS," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

wave_args=""
[ -n "$WAVE" ] && wave_args="--wave $WAVE"
base_args=""
[ -n "$BASE" ] && base_args="--base $BASE"

layer1_rc="SKIPPED"
layer2_rc="SKIPPED"
layer3_rc="SKIPPED"
layer4_rc="SKIPPED"

if want_layer 1; then
  echo "=== codemod-gates: layer 1 (grep + allowlist) ==="
  if sh scripts/gates/layer1-grep-allowlist.sh $wave_args > "$tmpdir/layer1.log" 2>&1; then
    layer1_rc="PASS"
  else
    layer1_rc="FAIL"
  fi
  cat "$tmpdir/layer1.log"
  echo "--- layer 1: $layer1_rc ---"
fi

if want_layer 2; then
  echo "=== codemod-gates: layer 2 (patterns + import-only diff) ==="
  l2_extra=""
  [ "$WORKTREE" -eq 1 ] && l2_extra="$l2_extra --worktree"
  if [ -n "$ENGINE_CMD" ]; then
    CODEMOD_ENGINE_CMD="$ENGINE_CMD" node scripts/gates/layer2-patterns-diff.mjs $wave_args $base_args --diff-scope "$DIFF_SCOPE" $l2_extra > "$tmpdir/layer2.log" 2>&1 && layer2_rc="PASS" || layer2_rc="FAIL"
  elif node scripts/gates/layer2-patterns-diff.mjs $wave_args $base_args --diff-scope "$DIFF_SCOPE" $l2_extra > "$tmpdir/layer2.log" 2>&1; then
    layer2_rc="PASS"
  else
    layer2_rc="FAIL"
  fi
  cat "$tmpdir/layer2.log"
  echo "--- layer 2: $layer2_rc ---"
fi

if want_layer 3; then
  echo "=== codemod-gates: layer 3 (lint + secret scan) ==="
  l3_files=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    l3_files="$l3_files --files $f"
  done < "$tmpdir/files.txt"
  if sh scripts/gates/layer3-lint-secret.sh $wave_args $base_args $l3_files > "$tmpdir/layer3.log" 2>&1; then
    layer3_rc="PASS"
  else
    layer3_rc="FAIL"
  fi
  cat "$tmpdir/layer3.log"
  echo "--- layer 3: $layer3_rc ---"
fi

if want_layer 4; then
  echo "=== codemod-gates: layer 4 (typecheck + contract + smoke) ==="
  l4_extra=""
  [ "$REQUIRE_SMOKE" -eq 1 ] && l4_extra="$l4_extra --require-smoke"
  [ "$REQUIRE_SERVER" -eq 1 ] && l4_extra="$l4_extra --require-server"
  [ "$SKIP_CONTRACT" -eq 1 ] && l4_extra="$l4_extra --skip-contract"
  if sh scripts/gates/layer4-typecheck-contract.sh $l4_extra > "$tmpdir/layer4.log" 2>&1; then
    layer4_rc="PASS"
  else
    layer4_rc="FAIL"
  fi
  cat "$tmpdir/layer4.log"
  echo "--- layer 4: $layer4_rc ---"
fi

skips=$(grep -h -c '^.*SKIP:' "$tmpdir"/layer*.log 2>/dev/null | awk '{s+=$1} END {print s+0}')
echo "=== codemod-gates summary ==="
echo "layer 1 (grep + allowlist): $layer1_rc"
echo "layer 2 (patterns + diff): $layer2_rc"
echo "layer 3 (lint + secret scan): $layer3_rc"
echo "layer 4 (typecheck + contract + smoke): $layer4_rc"
echo "skipped subchecks reported above: $skips (a skip is not a pass)"
echo "wave: ${WAVE:-none}, base: ${BASE:-none}, diff-scope: $DIFF_SCOPE, layers: $LAYERS"

if [ "$layer1_rc" = "FAIL" ] || [ "$layer2_rc" = "FAIL" ] || [ "$layer3_rc" = "FAIL" ] || [ "$layer4_rc" = "FAIL" ]; then
  echo "codemod-gates: FAIL"
  exit 1
fi
echo "codemod-gates: PASS"
exit 0
