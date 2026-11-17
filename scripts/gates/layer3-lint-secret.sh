#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork. See LICENSE and FORK.md.
#
# Codemod gate layer 3: lint + secret scan (V1-05 4.4/3, plus T7).
#
# Subchecks:
#   A. ESLint config shape: .eslintrc.json must match the merged M5
#      form (see check-eslint-shape.mjs). The gate uses the config in
#      the tree; it never re-implements the restriction patterns.
#   B. Lint run. Default: full `next lint` (the package.json `lint`
#      script, invoked as ./node_modules/.bin/next so the gate does
#      not depend on pnpm being on PATH). With
#      --files or --base: targeted ESLint JSON run over the changed
#      files, analyzed by eslint-wave-check.mjs (any
#      no-restricted-imports error fails; in wave mode any diagnostic
#      on a closed-wave specifier fails). ESLint does not flag dynamic
#      imports; layer 1 covers those by grep.
#   C. Secret scan: scripts/secret-scan.sh must exit 0. It scans
#      tracked files only, so in --base mode this layer additionally
#      scans added diff lines for the same value patterns and reports
#      file paths only, never matched content.
#   D. Em dash: 0 U+2014 in the gate scripts themselves and in added
#      diff lines (--base mode). Checked by byte sequence; the byte
#      pattern is built with printf so this script contains no em dash.
#
# Usage (from the repo root):
#   sh scripts/gates/layer3-lint-secret.sh [--wave G1|G2|G3|G4|G5|all]
#       [--base <ref>] [--files <file>]... [--skip-lint] [--skip-secret-scan]
#
# --skip-* flags print a loud SKIP and are meant for local diagnosis
# only; the runner never passes them. Exit 0 only when every
# non-skipped subcheck passes.

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd); fi
cd "$ROOT" || exit 1

WAVE=""
BASE=""
SKIP_LINT=0
SKIP_SECRET=0
FILES_FILE=""

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t layer3)
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
    --files)
      echo "$2" >> "$tmpdir/files.txt"
      shift 2
      ;;
    --skip-lint)
      SKIP_LINT=1
      shift
      ;;
    --skip-secret-scan)
      SKIP_SECRET=1
      shift
      ;;
    --help|-h)
      echo "Usage: sh scripts/gates/layer3-lint-secret.sh [--wave G1|G2|G3|G4|G5|all] [--base <ref>] [--files <file>]... [--skip-lint] [--skip-secret-scan]"
      exit 0
      ;;
    *)
      echo "layer3: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

failures=0

if [ -n "$BASE" ]; then
  if ! git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1; then
    echo "layer3: FAIL: base ref not found: $BASE"
    exit 1
  fi
fi

# Subcheck A: config shape.
echo "layer3: checking ESLint config shape (merged M5 form)"
if [ -n "$WAVE" ]; then
  shape_args="--wave $WAVE"
else
  shape_args=""
fi
if node scripts/gates/check-eslint-shape.mjs $shape_args; then
  echo "layer3: config shape PASS"
else
  echo "layer3: FAIL: ESLint config shape check failed"
  failures=$((failures + 1))
fi

# Subcheck B: lint.
if [ "$SKIP_LINT" -eq 1 ]; then
  echo "layer3: SKIP: lint skipped by --skip-lint (diagnosis only, not a pass)"
else
  if [ ! -x "node_modules/.bin/eslint" ] && ! command -v eslint >/dev/null 2>&1; then
    echo "layer3: FAIL: ESLint not installed (node_modules missing). Run pnpm install first; refusing to pass without lint."
    failures=$((failures + 1))
  elif [ -n "$BASE" ] || [ -s "$tmpdir/files.txt" ]; then
    if [ -n "$BASE" ]; then
      git diff --name-only "$BASE...HEAD" -- 'src/*.ts' 'src/*.tsx' 'src/**/*.ts' 'src/**/*.tsx' 2>/dev/null >> "$tmpdir/files.txt" || true
    fi
    LC_ALL=C sort -u "$tmpdir/files.txt" -o "$tmpdir/files.txt"
    # Keep only files that still exist.
    : > "$tmpdir/existing.txt"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ -f "$f" ] && echo "$f" >> "$tmpdir/existing.txt"
    done < "$tmpdir/files.txt"
    if [ ! -s "$tmpdir/existing.txt" ]; then
      echo "layer3: SKIP: no existing target files for targeted lint (empty file list)"
    else
      echo "layer3: targeted ESLint over $(wc -l < "$tmpdir/existing.txt" | tr -d ' ') file(s)"
      eslint_rc=0
      # eslint exits 1 when errors exist; capture JSON regardless.
      xargs -a "$tmpdir/existing.txt" -d '\n' ./node_modules/.bin/eslint --format json > "$tmpdir/eslint.json" 2> "$tmpdir/eslint.err" || eslint_rc=$?
      if [ ! -s "$tmpdir/eslint.json" ]; then
        echo "layer3: FAIL: ESLint produced no JSON output; stderr:"
        sed 's/^/  /' "$tmpdir/eslint.err" | head -n 20
        failures=$((failures + 1))
      else
        if node scripts/gates/eslint-wave-check.mjs "$tmpdir/eslint.json" $shape_args; then
          echo "layer3: targeted lint PASS"
        else
          echo "layer3: FAIL: targeted lint analysis failed"
          failures=$((failures + 1))
        fi
      fi
    fi
  else
    echo "layer3: full lint: next lint (package.json lint script)"
    if [ ! -x "node_modules/.bin/next" ]; then
      echo "layer3: FAIL: Next.js not installed (node_modules missing). Run pnpm install first; refusing to pass without lint."
      failures=$((failures + 1))
    elif ./node_modules/.bin/next lint > "$tmpdir/lint.log" 2>&1; then
      echo "layer3: full lint PASS (exit 0)"
      tail -n 3 "$tmpdir/lint.log" | sed 's/^/  /'
    else
      echo "layer3: FAIL: next lint exited non-zero; last 30 lines:"
      tail -n 30 "$tmpdir/lint.log" | sed 's/^/  /'
      failures=$((failures + 1))
    fi
  fi
fi

# Subcheck C: secret scan.
if [ "$SKIP_SECRET" -eq 1 ]; then
  echo "layer3: SKIP: secret scan skipped by --skip-secret-scan (diagnosis only, not a pass)"
else
  echo "layer3: running secret scan: sh scripts/secret-scan.sh"
  if sh scripts/secret-scan.sh; then
    echo "layer3: secret scan PASS (tracked files)"
  else
    echo "layer3: FAIL: secret scan failed (see output above; values are never printed)"
    failures=$((failures + 1))
  fi
  if [ -n "$BASE" ]; then
    echo "layer3: scanning added diff lines for secret patterns (file paths only)"
    git diff --unified=0 --no-color "$BASE...HEAD" -- 2>/dev/null | awk '
      substr($0, 1, 6) == "+++ b/" { file = substr($0, 7); next }
      substr($0, 1, 1) == "+" {
        line = substr($0, 2)
        if (line ~ /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_.-]{10,}|AKIA[0-9A-Z]{16}/) found[file] = 1
        else if (line ~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/) found[file] = 1
        else if (line ~ /postgres(ql)?:\/\/[^:\/<> ]+:[^@<> ]+@/) found[file] = 1
        else if (line ~ /sk-[A-Za-z0-9]{20,}/) found[file] = 1
        else if (line ~ /(AUTH_SECRET|SECRETS_ENCRYPTION_KEY|SETUP_TOKEN|INTERNAL_SERVICE_TOKEN|CF_ACCESS_AUD)[ \t]*=[ \t]*["'"'"']?[^ \t#\"'"'"']/ && line !~ /CHANGE_ME/ && line !~ /<[^>]*>/) found[file] = 1
      }
      END { for (f in found) print f }
    ' > "$tmpdir/secret-diff.txt" || true
    if [ -s "$tmpdir/secret-diff.txt" ]; then
      echo "layer3: FAIL: secret-like pattern in added diff lines (file paths only):"
      sed 's/^/  /' "$tmpdir/secret-diff.txt"
      failures=$((failures + 1))
    else
      echo "layer3: added-lines secret scan PASS"
    fi
  fi
fi

# Subcheck D: em dash (U+2014) by byte sequence.
EMDASH=$(printf '\342\200\224')
emdash_files=""
for f in scripts/gates/*; do
  if [ -f "$f" ] && grep -q "$EMDASH" "$f" 2>/dev/null; then
    emdash_files="$emdash_files $f"
  fi
done
if [ -n "$BASE" ]; then
  git diff --unified=0 --no-color "$BASE...HEAD" -- 2>/dev/null | grep '^+' | grep -v '^+++' | grep -q "$EMDASH" && emdash_files="$emdash_files (added diff lines)"
fi
if [ -n "$emdash_files" ]; then
  echo "layer3: FAIL: em dash (U+2014) found in:$emdash_files"
  failures=$((failures + 1))
else
  echo "layer3: em dash check PASS (0 U+2014 in gate scripts and added diff lines)"
fi

if [ "$failures" -gt 0 ]; then
  echo "layer3: FAIL ($failures check(s) failed)"
  exit 1
fi
echo "layer3: PASS"
exit 0
