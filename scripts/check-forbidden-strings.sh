#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Forbidden-string gate for the web fork (AD-14, AD-109, W4-SEC).
#
# Terminal execution is removed permanently from the fork web: no
# phase enables it, no flag enables it, and no server equivalent may
# be built (design F8 section 5). The two forbidden literals must not
# appear anywhere under src/. Wave 3 grandfathered 11 pre-existing
# lines under AD-109 with a diff-only gate scope; wave 4 (W4-SEC)
# deleted all 11 lines, so this gate now enforces zero hits.
#
# Scope: the src/ tree only, fixed-string match (grep -F). A regex
# search with an unescaped dot overcounts: it also matches the
# "terminal opener removed" comment in src/lib/editor-disabled.ts,
# which is not a literal. Do not widen this script to a regex search
# and do not widen its scope to src-tauri/, where the desktop Rust
# backend still carries its own command names outside the web build.
#
# This script itself holds the two search patterns. That is safe: the
# search scope is src/ only, and this file lives in scripts/.
#
# The CI forbidden-strings job runs exactly this script. It needs no
# dependency install. Until GitHub Actions runs for this repository,
# run it locally; the job command and the local command are the same.
#
# Usage: bash scripts/check-forbidden-strings.sh   (from anywhere inside the repo)
# Exit code: 0 when clean, 1 when any hit is found.

set -eu

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

echo "forbidden-strings: clean (0 hits in src/)."
