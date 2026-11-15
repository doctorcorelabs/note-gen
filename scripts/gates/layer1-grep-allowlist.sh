#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork. See LICENSE and FORK.md.
#
# Codemod gate layer 1: grep per specifier + allowlist (V1-05 4.4/1).
#
# This layer runs the merged M5 platform guard
# (scripts/platform-guard.sh, the form that landed in the merge, not
# the V2-04 branch form), recounts the live import baseline, and, in
# wave mode, requires 0 remaining import lines outside
# src/lib/platform/ for every specifier whose wave has closed.
#
# The guard exact match (current tree vs current allowlist) is the
# live invariant. The recorded baseline
# (scripts/gates/baseline-allowlist.json) is the G0 reference state;
# deltas against it are reported as information only, because waves
# legitimately shrink the counts. A delta alone never fails this layer.
#
# api/core is special: it closes at G2 except the convertFileSrc
# subset, which closes at G3. In G2 mode this layer delegates the
# api/core remainder to check-api-core-subset.mjs, which inspects the
# imported bindings instead of trusting the allowlist wave column.
#
# Usage (from the repo root):
#   sh scripts/gates/layer1-grep-allowlist.sh [--wave G1|G2|G3|G4|G5|all]
#       [--baseline <path>] [--recount-only]
#
# Exit 0 when the guard passes and every wave assertion passes.
# Exit 1 otherwise. Exit 2 on bad arguments.

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd); fi
cd "$ROOT" || exit 1

WAVE=""
BASELINE="scripts/gates/baseline-allowlist.json"
RECOUNT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --wave)
      WAVE="$2"
      shift 2
      ;;
    --baseline)
      BASELINE="$2"
      shift 2
      ;;
    --recount-only)
      RECOUNT_ONLY=1
      shift
      ;;
    --help|-h)
      echo "Usage: sh scripts/gates/layer1-grep-allowlist.sh [--wave G1|G2|G3|G4|G5|all] [--baseline <path>] [--recount-only]"
      exit 0
      ;;
    *)
      echo "layer1: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$WAVE" in
  ""|G1|G2|G3|G4|G5|all) ;;
  *)
    echo "layer1: unknown wave: $WAVE (expected G1, G2, G3, G4, G5, or all)" >&2
    exit 2
    ;;
esac

failures=0

# Step 1: the merged M5 guard. At G5 the allowlist may already be
# deleted by V3-21; the guard fails when its allowlist is missing, so
# in that state this layer checks the 0-import invariant directly and
# says so explicitly instead of calling the guard.
if [ "$WAVE" = "G5" ] || [ "$WAVE" = "all" ]; then
  if [ ! -f "scripts/ci/tauri-import-allowlist.txt" ]; then
    echo "layer1: allowlist deleted (G5 state); checking 0 imports directly"
    remaining=$(grep -rn --include='*.ts' --include='*.tsx' -e '@tauri-apps/' -e 'tauri-plugin-clipboard-api' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
    if [ "$remaining" != "0" ]; then
      echo "layer1: FAIL: $remaining Tauri import line(s) remain outside src/lib/platform/ after G5"
      failures=$((failures + 1))
    else
      echo "layer1: PASS: 0 Tauri import lines outside src/lib/platform/"
    fi
  fi
fi

if [ ! -f "scripts/ci/tauri-import-allowlist.txt" ] && { [ "$WAVE" = "G5" ] || [ "$WAVE" = "all" ]; }; then
  : # guard skipped, direct check above already ran
elif [ "$RECOUNT_ONLY" -eq 0 ]; then
  echo "layer1: running merged M5 guard: sh scripts/platform-guard.sh"
  if sh scripts/platform-guard.sh; then
    echo "layer1: guard PASS"
  else
    echo "layer1: FAIL: platform guard failed (see output above)"
    failures=$((failures + 1))
  fi
else
  echo "layer1: --recount-only: guard not run"
fi

# Step 2: recount the live baseline with the guard extraction.
tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t layer1)
trap 'rm -rf "$tmpdir"' EXIT INT TERM
: > "$tmpdir/pairs.txt"
grep -rln --include='*.ts' --include='*.tsx' \
  -e '@tauri-apps/' -e 'tauri-plugin-clipboard-api' \
  src --exclude-dir=platform 2>/dev/null | LC_ALL=C sort > "$tmpdir/files.txt" || true
while IFS= read -r file; do
  [ -n "$file" ] || continue
  grep -o -e '@tauri-apps/[A-Za-z0-9][A-Za-z0-9/_-]*' \
    -e 'tauri-plugin-clipboard-api' "$file" 2>/dev/null | LC_ALL=C sort -u |
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      echo "$file:$spec" >> "$tmpdir/pairs.txt"
    done
done < "$tmpdir/files.txt"
LC_ALL=C sort -u "$tmpdir/pairs.txt" -o "$tmpdir/pairs.txt"
live_pairs=$(wc -l < "$tmpdir/pairs.txt" | tr -d ' ')
live_files=$(wc -l < "$tmpdir/files.txt" | tr -d ' ')
live_lines=$(grep -rn --include='*.ts' --include='*.tsx' -e '@tauri-apps/' -e 'tauri-plugin-clipboard-api' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
echo "layer1: live recount: $live_pairs pairs, $live_files files, $live_lines lines outside src/lib/platform/"

if [ -f "$BASELINE" ]; then
  if command -v node >/dev/null 2>&1; then
    base_pairs=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).pairsFileSpecifier)" "$BASELINE")
    base_files=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).filesOutsidePlatformWithTauriAppsOrVendor)" "$BASELINE")
    base_lines=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).linesOutsidePlatformWithTauriApps + JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).linesOutsidePlatformVendor)" "$BASELINE")
    echo "layer1: baseline (G0): $base_pairs pairs, $base_files files, $base_lines lines; delta: $((live_pairs - base_pairs)) pairs, $((live_files - base_files)) files, $((live_lines - base_lines)) lines (informational only)"
  else
    echo "layer1: node not found; baseline delta not computed (baseline file present: $BASELINE)"
  fi
else
  echo "layer1: WARNING: baseline file not found: $BASELINE (delta not computed)"
fi

# Step 3: per-specifier counts for every known specifier.
echo "layer1: per-specifier line counts outside src/lib/platform/:"
specs="plugin-store plugin-sql plugin-fs plugin-dialog plugin-opener plugin-clipboard-manager plugin-http plugin-os plugin-notification plugin-global-shortcut plugin-shell plugin-process plugin-autostart plugin-updater api/core api/path api/window api/webviewWindow api/event api/app api/image"
for s in $specs; do
  c=$(grep -rn --include='*.ts' --include='*.tsx' "@tauri-apps/$s" src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
  echo "  @tauri-apps/$s: $c"
done
vc=$(grep -rn --include='*.ts' --include='*.tsx' 'tauri-plugin-clipboard-api' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
echo "  tauri-plugin-clipboard-api: $vc"

# Step 4: wave assertions (cumulative). Without --wave there is no
# wave assertion; the guard exact match is the whole check.
if [ -n "$WAVE" ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "layer1: FAIL: wave mode requires node (to read scripts/gates/waves.json)"
    failures=$((failures + 1))
  else
    case "$WAVE" in
      G1) wanted="G1" ;;
      G2) wanted="G1 G2" ;;
      G3) wanted="G1 G2 G3" ;;
      G4) wanted="G1 G2 G3 G4" ;;
      G5|all) wanted="G1 G2 G3 G4 G5" ;;
    esac
    wave_specs=$(node -e "
      const w = JSON.parse(require('fs').readFileSync('scripts/gates/waves.json', 'utf8')).waves;
      const names = process.argv.slice(1);
      const out = [];
      for (const n of names) for (const s of w[n]) if (!out.includes(s)) out.push(s);
      console.log(out.join('\n'));
    " $wanted)
    for spec in $wave_specs; do
      if [ "$spec" = "@tauri-apps/api/core" ] && [ "$WAVE" = "G2" ]; then
        echo "layer1: api/core at G2: delegating to binding check (convertFileSrc subset closes at G3)"
        if node scripts/gates/check-api-core-subset.mjs; then
          echo "layer1: api/core G2 remainder PASS (convertFileSrc-only)"
        else
          echo "layer1: FAIL: api/core G2 remainder check failed (see output above)"
          failures=$((failures + 1))
        fi
        continue
      fi
      c=$(grep -rn --include='*.ts' --include='*.tsx' "$spec" src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
      if [ "$c" != "0" ]; then
        echo "layer1: FAIL: $spec still has $c import line(s) outside src/lib/platform/ after wave $WAVE"
        failures=$((failures + 1))
      else
        echo "layer1: PASS: $spec 0 lines after wave $WAVE"
      fi
    done
    if [ "$WAVE" = "G5" ] || [ "$WAVE" = "all" ]; then
      if [ -f "scripts/ci/tauri-import-allowlist.txt" ]; then
        entries=$(grep -v '^#' scripts/ci/tauri-import-allowlist.txt | grep -v '^$' | wc -l | tr -d ' ')
        if [ "$entries" != "0" ]; then
          echo "layer1: FAIL: allowlist still has $entries entr(ies) after G5; V3-21 must delete it"
          failures=$((failures + 1))
        else
          echo "layer1: allowlist present but empty of entries (acceptable G5 state; deletion preferred)"
        fi
      else
        echo "layer1: PASS: allowlist deleted (G5 state)"
      fi
    fi
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "layer1: FAIL ($failures check(s) failed)"
  exit 1
fi
echo "layer1: PASS"
exit 0
