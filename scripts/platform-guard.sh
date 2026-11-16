#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork. See LICENSE and FORK.md.
#
# Grep gate for the Tauri platform registry (AD-07).
#
# This gate is the second enforcement layer next to the ESLint
# no-restricted-imports overrides in .eslintrc.json. It runs on every
# pull request to web and on every upstream sync, and it must pass
# without depending on the lint configuration being correct.
#
# Usage: sh scripts/platform-guard.sh
#   Runs from any working directory; paths resolve against the repo root.
#   Exit 0 when every check passes, exit 1 otherwise.
#
#   PLATFORM_GUARD_STRICT=1 sh scripts/platform-guard.sh
#   Also enforces check 4 (raw Store load and raw invoke calls). Check 4
#   is informational by default until waves G1 (Store) and G2 (invoke)
#   close; strict mode exists for the wave gates and for CI after G2.
#
# Checks (scope: src/ only; Rust code in src-tauri/ is out of scope):
#   1. Tauri module imports outside src/lib/platform/ must match the
#      allowlist in scripts/ci/tauri-import-allowlist.txt exactly: no
#      import outside the allowlist (a new import that bypassed the
#      registry), and no stale allowlist entry (a file that no longer
#      imports the module must lose its entry when it migrates). At G5
#      the allowlist is deleted (V3-21); check 1 then enforces the
#      funnel-only invariant directly (AD-90, self-expiring at V3-14).
#   2. The Tauri internals marker outside src/lib/platform/detect.ts
#      must match the allowlist in
#      scripts/ci/tauri-internals-allowlist.txt exactly.
#   3. Direct imports of adapter implementations (*.tauri, *.web) are
#      forbidden everywhere except src/lib/platform/registry.ts,
#      src/lib/platform/__tests__/, and the AD-33 wiring modules
#      src/lib/platform/wiring.ts and
#      src/lib/platform/dialog/dialog-wiring.ts (G-3B4 fix-up:
#      the guard predates AD-33; wiring modules must import the
#      implementations they register).
#   4. Raw Store load calls and raw invoke calls outside
#      src/lib/platform/ are counted and reported. Informational until
#      the closing wave of each surface; enforced only in strict mode.
#
# Allowlist entries use the form path:specifier:closing-wave, one per
# line. The closing wave is metadata for the migration plan; this gate
# compares path:specifier pairs and ignores the wave column. When a
# wave closes, its entries are deleted together with the migration.
# At G5 the allowlist is deleted and the ESLint override becomes an
# error; no temporary exception mechanism remains after that.

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

IMPORT_ALLOWLIST="scripts/ci/tauri-import-allowlist.txt"
INTERNALS_ALLOWLIST="scripts/ci/tauri-internals-allowlist.txt"
STRICT=${PLATFORM_GUARD_STRICT:-0}

failures=0

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t platform-guard)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

# Check 1: Tauri imports outside src/lib/platform/ versus the allowlist.
echo "check 1: Tauri imports outside src/lib/platform/"
if [ ! -f "$IMPORT_ALLOWLIST" ]; then
  # G5 state (V3-21, rev5b Temuan 9): the allowlist is deleted. Check 1
  # enforces the funnel-only invariant directly: the only permitted
  # pair is the AD-90 SQL funnel (exactly src/db/index.ts plugin-sql,
  # self-expiring at V3-14); zero pairs also passes (post-V3-14 state).
  # Do NOT close this branch by restoring the allowlist (rev5b).
  : > "$tmpdir/actual-pairs.txt"
  grep -rln --include='*.ts' --include='*.tsx' \
    -e '@tauri-apps/' -e 'tauri-plugin-clipboard-api' \
    src --exclude-dir=platform 2>/dev/null | LC_ALL=C sort > "$tmpdir/files.txt" || true
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -o -e '@tauri-apps/[A-Za-z0-9][A-Za-z0-9/_-]*' \
      -e 'tauri-plugin-clipboard-api' "$file" 2>/dev/null | LC_ALL=C sort -u |
      while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        echo "$file:$spec" >> "$tmpdir/actual-pairs.txt"
      done
  done < "$tmpdir/files.txt"
  LC_ALL=C sort -u "$tmpdir/actual-pairs.txt" -o "$tmpdir/actual-pairs.txt"
  offending=$(grep -v '^src/db/index.ts:@tauri-apps/plugin-sql$' "$tmpdir/actual-pairs.txt" || true)
  if [ -n "$offending" ]; then
    echo "  FAIL: Tauri imports remain outside src/lib/platform/ after G5 (allowlist deleted; only the AD-90 funnel is permitted):"
    echo "$offending" | sed 's/^/    /'
    failures=$((failures + 1))
  else
    count=$(wc -l < "$tmpdir/actual-pairs.txt" | tr -d ' ')
    echo "  PASS: G5 state, $count pair(s) (funnel-only, AD-90)"
  fi
else
  : > "$tmpdir/actual-pairs.txt"
  grep -rln --include='*.ts' --include='*.tsx' \
    -e '@tauri-apps/' -e 'tauri-plugin-clipboard-api' \
    src --exclude-dir=platform 2>/dev/null | LC_ALL=C sort > "$tmpdir/files.txt" || true
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -o -e '@tauri-apps/[A-Za-z0-9][A-Za-z0-9/_-]*' \
      -e 'tauri-plugin-clipboard-api' "$file" 2>/dev/null | LC_ALL=C sort -u |
      while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        echo "$file:$spec" >> "$tmpdir/actual-pairs.txt"
      done
  done < "$tmpdir/files.txt"
  LC_ALL=C sort -u "$tmpdir/actual-pairs.txt" -o "$tmpdir/actual-pairs.txt"
  grep -v '^#' "$IMPORT_ALLOWLIST" | grep -v '^$' | cut -d: -f1,2 |
    LC_ALL=C sort -u > "$tmpdir/allowlist-pairs.txt" || true
  new_imports=$(comm -23 "$tmpdir/actual-pairs.txt" "$tmpdir/allowlist-pairs.txt" || true)
  stale_entries=$(comm -13 "$tmpdir/actual-pairs.txt" "$tmpdir/allowlist-pairs.txt" || true)
  if [ -n "$new_imports" ] || [ -n "$stale_entries" ]; then
    echo "  FAIL: import set does not match the allowlist"
    if [ -n "$new_imports" ]; then
      echo "  imports outside the allowlist (migrate through the registry):"
      echo "$new_imports" | sed 's/^/    /'
    fi
    if [ -n "$stale_entries" ]; then
      echo "  stale allowlist entries (delete with the migration):"
      echo "$stale_entries" | sed 's/^/    /'
    fi
    failures=$((failures + 1))
  else
    count=$(wc -l < "$tmpdir/actual-pairs.txt" | tr -d ' ')
    echo "  PASS: $count file:specifier pairs match the allowlist"
  fi
fi

# Check 2: Tauri internals marker outside detect.ts versus the allowlist.
echo "check 2: Tauri internals marker outside src/lib/platform/detect.ts"
if [ ! -f "$INTERNALS_ALLOWLIST" ]; then
  echo "  FAIL: allowlist not found: $INTERNALS_ALLOWLIST"
  failures=$((failures + 1))
else
  grep -rln --include='*.ts' --include='*.tsx' '__TAURI_INTERNALS__' src 2>/dev/null |
    grep -v '^src/lib/platform/detect.ts$' | LC_ALL=C sort > "$tmpdir/actual-internals.txt" || true
  grep -v '^#' "$INTERNALS_ALLOWLIST" | grep -v '^$' |
    LC_ALL=C sort -u > "$tmpdir/allowlist-internals.txt" || true
  new_markers=$(comm -23 "$tmpdir/actual-internals.txt" "$tmpdir/allowlist-internals.txt" || true)
  stale_markers=$(comm -13 "$tmpdir/actual-internals.txt" "$tmpdir/allowlist-internals.txt" || true)
  if [ -n "$new_markers" ] || [ -n "$stale_markers" ]; then
    echo "  FAIL: marker set does not match the allowlist"
    if [ -n "$new_markers" ]; then
      echo "  files mentioning the marker outside the allowlist:"
      echo "$new_markers" | sed 's/^/    /'
    fi
    if [ -n "$stale_markers" ]; then
      echo "  stale allowlist entries:"
      echo "$stale_markers" | sed 's/^/    /'
    fi
    failures=$((failures + 1))
  else
    count=$(wc -l < "$tmpdir/actual-internals.txt" | tr -d ' ')
    echo "  PASS: $count files match the allowlist"
  fi
fi

# Check 3: direct implementation imports outside registry.ts and tests.
# Exception (G2 merge; deletion deferred to 3D by AD-91): the transitional
# re-export src/lib/tauri-event-listener.ts (deleted at 3D when the
# registry-surface decision for listenTauriEvent lands) necessarily
# imports the relocated *.tauri implementation.
# 3D MUST remove this exclusion together with the file (AD-91 replaces
# the earlier G4 obligation recorded at the G2 merge).
echo "check 3: direct adapter implementation imports"
direct=$(grep -rn --include='*.ts' --include='*.tsx' -E \
  "from ['\"][^'\"]*\.(tauri|web)['\"]|import\(['\"][^'\"]*\.(tauri|web)['\"]\)" \
  src 2>/dev/null | grep -v 'src/lib/platform/registry.ts' |
  grep -v 'src/lib/platform/wiring.ts' |
  grep -v 'src/lib/platform/dialog/dialog-wiring.ts' |
  grep -v 'src/lib/tauri-event-listener.ts' |
  grep -v 'src/lib/platform/__tests__/' |
  grep -v -E '^[^:]*\.(test|spec)\.tsx?:' || true)
if [ -n "$direct" ]; then
  echo "  FAIL: direct implementation imports found:"
  echo "$direct" | sed 's/^/    /'
  failures=$((failures + 1))
else
  echo "  PASS: no direct implementation imports"
fi

# Check 4: raw Store load and raw invoke calls (informational at G0).
echo "check 4: raw Store load and raw invoke calls (informational)"
store_hits=$(grep -rn --include='*.ts' --include='*.tsx' -E \
  '(^|[^A-Za-z0-9_.])Store\.load[[:space:]]*\(' \
  src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
invoke_hits=$(grep -rn --include='*.ts' --include='*.tsx' -E \
  '(^|[^A-Za-z0-9_.])invoke[[:space:]]*(\(|<)' \
  src --exclude-dir=platform 2>/dev/null |
  grep -v 'plugin-item-list.tsx' | wc -l | tr -d ' ')
echo "  Store load call lines outside platform: $store_hits (closes at G1)"
echo "  invoke call lines outside platform: $invoke_hits (closes at G2)"
if [ "$STRICT" = "1" ]; then
  if [ "$store_hits" != "0" ] || [ "$invoke_hits" != "0" ]; then
    echo "  FAIL: strict mode requires 0 raw calls"
    failures=$((failures + 1))
  else
    echo "  PASS (strict): 0 raw calls"
  fi
else
  echo "  PASS (informational; set PLATFORM_GUARD_STRICT=1 to enforce)"
fi

if [ "$failures" -gt 0 ]; then
  echo "platform-guard: FAIL ($failures check(s) failed)"
  exit 1
fi
echo "platform-guard: PASS"
exit 0
