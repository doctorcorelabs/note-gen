#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Forbidden-string gate for the web fork (AD-14, AD-109, W4-SEC, DA-14-N01).
#
# Terminal execution is removed permanently from the fork web: no
# phase enables it, no flag enables it, and no server equivalent may
# be built (design F8 section 5). The two forbidden literals must not
# appear anywhere under src/. Wave 3 grandfathered 11 pre-existing
# lines under AD-109 with a diff-only gate scope; wave 4 (W4-SEC)
# deleted all 11 lines, so this gate now enforces zero hits.
#
# Scope, part 1 (source): the src/ tree only, fixed-string match
# (grep -F). A regex search with an unescaped dot overcounts: it also
# matches the "terminal opener removed" comment in
# src/lib/editor-disabled.ts, which is not a literal. Do not widen
# this script to a regex search and do not widen its scope to
# src-tauri/, where the desktop Rust backend still carries its own
# command names outside the web build.
#
# Scope, part 2 (built worker bundles, DA-14-N01): the built worker
# bundle public/plugin-runtime.js and its static-export copy
# out/plugin-runtime.js, fixed-string match (grep -F) for the bare
# string 'terminal'. A stale bundle built before W4-SEC advertised
# the removed 'terminal' capability as a bare string in its
# capabilities array, which neither forbidden literal matches, so a
# src/-only gate cannot see the drift. A fresh bundle contains zero
# occurrences: the capability list in the worker source no longer
# names it, and minification strips the source comments that use
# 'terminal' as an ordinary word (DA-14 verified a scratch rebuild:
# 0 occurrences). Do not extend the bare-string check to src/: those
# comments and the removal spec would false-positive there. Do not
# widen the check to other bundles: only the plugin worker bundle
# carries a capabilities array.
#
# This script itself holds the search patterns. That is safe: the
# search scopes are src/ and the two worker bundle files only, and
# this file lives in scripts/.
#
# Bundle output safety: the gate reports file paths and occurrence
# counts only. It never prints a matched line: the minified bundle
# is effectively one line, and printing it would dump the bundle.
#
# Modes:
#   (no argument)  Check src/ plus each worker bundle file that is
#                  present. A missing bundle is skipped, never a
#                  failure: a fresh checkout has no built artifacts.
#   --built        Post-build gate. Both bundle files must exist and
#                  be clean; a missing file fails, so the gate can
#                  never pass vacuously after a build.
#
# The CI forbidden-strings job runs exactly this script with no
# argument. It needs no dependency install. The CI build job runs
# this script with --built after pnpm build. Until GitHub Actions
# runs for this repository, run both forms locally; the job commands
# and the local commands are the same.
#
# Usage: bash scripts/check-forbidden-strings.sh [--built]
#        (from anywhere inside the repo)
# Exit code: 0 when clean, 1 when any hit is found, when src/ is
# missing, or (with --built) when a bundle file is missing.

set -eu

BUILT=0
if [ "${1:-}" = "--built" ]; then
  BUILT=1
  shift
fi
if [ $# -gt 0 ]; then
  echo "forbidden-strings: unknown argument: $1" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ ! -d src ]; then
  echo "forbidden-strings: src/ directory not found under $ROOT" >&2
  exit 1
fi

hits=$(grep -rn -F -e 'terminal.open' -e 'plugin_terminal' src/ || true)

if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "forbidden-strings: FAIL: forbidden literals found in src/ (see lines above)." >&2
  echo "Remove the literals. Do not add an exception without a coordinator decision (AD-109)." >&2
  exit 1
fi

# Built worker bundles (DA-14-N01). The bare string subsumes both
# forbidden literals: 'terminal.open' and 'plugin_terminal' both
# contain 'terminal'. Counts only; matched lines are never printed.
checked=0
skipped=0
dirty=0
for artifact in public/plugin-runtime.js out/plugin-runtime.js; do
  if [ ! -f "$artifact" ]; then
    if [ "$BUILT" -eq 1 ]; then
      echo "forbidden-strings: FAIL: --built requires $artifact (run after pnpm build)." >&2
      dirty=1
    else
      skipped=$((skipped + 1))
    fi
    continue
  fi
  if [ ! -r "$artifact" ]; then
    echo "forbidden-strings: FAIL: $artifact is not readable." >&2
    dirty=1
    continue
  fi
  checked=$((checked + 1))
  count=$( (grep -a -o -F -e 'terminal' -- "$artifact" 2>/dev/null || true) | wc -l | tr -d '[:space:]')
  if [ "${count:-0}" -gt 0 ]; then
    echo "forbidden-strings: FAIL: $count occurrence(s) of 'terminal' in $artifact (counts only; matched lines never printed)." >&2
    dirty=1
  fi
done

if [ "$dirty" -ne 0 ]; then
  echo "forbidden-strings: FAIL: stale or missing built worker bundle. Rebuild with pnpm plugin-runtime:build (or pnpm build) and do not reuse a stale public/ or out/ bundle (DA-14-N01)." >&2
  exit 1
fi

echo "forbidden-strings: clean (0 hits in src/; $checked built worker artifact(s) checked, $skipped skipped)."
