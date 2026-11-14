#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork. See LICENSE and FORK.md.
#
# Codemod gate layer 4: typecheck + contract + smoke (V1-05 4.4/4).
#
# Subchecks:
#   A. Root typecheck: `pnpm typecheck` (tsc --noEmit) must exit 0.
#      Missing node_modules fails; this layer never passes without
#      running the typechecker.
#   B. Server typecheck: run when server dependencies are installed;
#      otherwise reported SKIP (loudly), unless --require-server.
#      Codemod waves do not touch server/, so a missing server install
#      must not silently count as a pass, nor block a frontend gate
#      without the integrator asking for it.
#   C. Contract suite: `pnpm test:contract` (vitest contract project)
#      must exit 0 and must report at least one test file and one test
#      (an empty suite is a failure, per AD-36). With --contract-files
#      the given spec files run explicitly instead of the whole
#      project. --skip-contract prints a loud SKIP for diagnosis only.
#   D. Smoke: skipped by default with a loud SKIP and instructions;
#      --require-smoke runs `pnpm e2e:smoke` (Playwright) and requires
#      exit 0. Smoke needs browsers and a built app; the default skip
#      is honest reporting, not a pass, and the runner surfaces the
#      skip count in its summary.
#
# Usage (from the repo root):
#   sh scripts/gates/layer4-typecheck-contract.sh [--skip-contract]
#       [--require-smoke] [--require-server] [--contract-files <spec>]...
#
# Exit 0 only when every non-skipped subcheck passes.

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd); fi
cd "$ROOT" || exit 1

SKIP_CONTRACT=0
REQUIRE_SMOKE=0
REQUIRE_SERVER=0

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t layer4)
trap 'rm -rf "$tmpdir"' EXIT INT TERM
: > "$tmpdir/contract-files.txt"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-contract)
      SKIP_CONTRACT=1
      shift
      ;;
    --require-smoke)
      REQUIRE_SMOKE=1
      shift
      ;;
    --require-server)
      REQUIRE_SERVER=1
      shift
      ;;
    --contract-files)
      echo "$2" >> "$tmpdir/contract-files.txt"
      shift 2
      ;;
    --help|-h)
      echo "Usage: sh scripts/gates/layer4-typecheck-contract.sh [--skip-contract] [--require-smoke] [--require-server] [--contract-files <spec>]..."
      exit 0
      ;;
    *)
      echo "layer4: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

failures=0

# Subcheck A: root typecheck.
echo "layer4: root typecheck: pnpm typecheck"
if [ ! -x "node_modules/.bin/tsc" ]; then
  echo "layer4: FAIL: TypeScript not installed (node_modules missing). Run pnpm install first; refusing to pass without typecheck."
  failures=$((failures + 1))
else
  start=$(date +%s)
  if pnpm typecheck > "$tmpdir/typecheck.log" 2>&1; then
    elapsed=$(( $(date +%s) - start ))
    echo "layer4: root typecheck PASS (${elapsed}s)"
  else
    echo "layer4: FAIL: root typecheck exited non-zero; last 30 lines:"
    tail -n 30 "$tmpdir/typecheck.log" | sed 's/^/  /'
    failures=$((failures + 1))
  fi
fi

# Subcheck B: server typecheck.
if [ -f "server/package.json" ]; then
  if [ -x "server/node_modules/.bin/tsc" ]; then
    echo "layer4: server typecheck: pnpm --dir server typecheck"
    if pnpm --dir server typecheck > "$tmpdir/server-typecheck.log" 2>&1; then
      echo "layer4: server typecheck PASS"
    else
      echo "layer4: FAIL: server typecheck exited non-zero; last 30 lines:"
      tail -n 30 "$tmpdir/server-typecheck.log" | sed 's/^/  /'
      failures=$((failures + 1))
    fi
  else
    if [ "$REQUIRE_SERVER" -eq 1 ]; then
      echo "layer4: FAIL: server dependencies not installed and --require-server was given"
      failures=$((failures + 1))
    else
      echo "layer4: SKIP: server typecheck not run (server/node_modules missing; install server deps or pass --require-server to enforce)"
    fi
  fi
else
  echo "layer4: SKIP: no server/package.json (server typecheck not applicable)"
fi

# Subcheck C: contract suite.
if [ "$SKIP_CONTRACT" -eq 1 ]; then
  echo "layer4: SKIP: contract suite skipped by --skip-contract (diagnosis only, not a pass)"
else
  if [ ! -x "node_modules/.bin/vitest" ]; then
    echo "layer4: FAIL: Vitest not installed (node_modules missing). Run pnpm install first; refusing to pass without the contract suite."
    failures=$((failures + 1))
  else
    if [ -s "$tmpdir/contract-files.txt" ]; then
      echo "layer4: contract suite over explicit spec files:"
      sed 's/^/  /' "$tmpdir/contract-files.txt"
      contract_rc=0
      xargs -a "$tmpdir/contract-files.txt" -d '\n' ./node_modules/.bin/vitest run --project contract > "$tmpdir/contract.log" 2>&1 || contract_rc=$?
    else
      echo "layer4: contract suite: pnpm test:contract"
      contract_rc=0
      pnpm test:contract > "$tmpdir/contract.log" 2>&1 || contract_rc=$?
    fi
    if [ "$contract_rc" -ne 0 ]; then
      echo "layer4: FAIL: contract suite exited $contract_rc; last 30 lines:"
      tail -n 30 "$tmpdir/contract.log" | sed 's/^/  /'
      failures=$((failures + 1))
    elif ! grep -qE 'Test Files +[1-9][0-9]* passed' "$tmpdir/contract.log"; then
      echo "layer4: FAIL: contract run produced no passing test files in its summary (empty suite is not a pass, AD-36); last 20 lines:"
      tail -n 20 "$tmpdir/contract.log" | sed 's/^/  /'
      failures=$((failures + 1))
    elif ! grep -qE 'Tests +[1-9][0-9]* passed' "$tmpdir/contract.log"; then
      echo "layer4: FAIL: contract run produced no passing tests in its summary (empty suite is not a pass, AD-36); last 20 lines:"
      tail -n 20 "$tmpdir/contract.log" | sed 's/^/  /'
      failures=$((failures + 1))
    else
      echo "layer4: contract suite PASS"
      grep -E 'Test Files|Tests ' "$tmpdir/contract.log" | tail -n 4 | sed 's/^/  /'
    fi
  fi
fi

# Subcheck D: smoke.
if [ "$REQUIRE_SMOKE" -eq 1 ]; then
  echo "layer4: smoke: pnpm e2e:smoke"
  if pnpm e2e:smoke > "$tmpdir/smoke.log" 2>&1; then
    echo "layer4: smoke PASS"
  else
    echo "layer4: FAIL: smoke exited non-zero; last 30 lines:"
    tail -n 30 "$tmpdir/smoke.log" | sed 's/^/  /'
    failures=$((failures + 1))
  fi
else
  echo "layer4: SKIP: smoke not run by default (needs Playwright browsers + built app). Run pnpm e2e:smoke separately, or pass --require-smoke to enforce it here."
fi

if [ "$failures" -gt 0 ]; then
  echo "layer4: FAIL ($failures check(s) failed)"
  exit 1
fi
echo "layer4: PASS"
exit 0
