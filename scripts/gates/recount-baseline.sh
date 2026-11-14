#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork. See LICENSE and FORK.md.
#
# Recount the Tauri import baseline over the actual tree.
#
# This script recomputes, from the working tree, every number recorded
# in scripts/gates/baseline-allowlist.json: file:specifier pairs (with
# the exact extraction the platform guard uses), importing files,
# import lines, per-specifier counts, internals marker files, raw
# Store.load / invoke call lines, and dynamic import lines. It never
# copies a number from a document; run it to verify the baseline or to
# measure a tree after a codemod wave.
#
# Usage (from the repo root):
#   sh scripts/gates/recount-baseline.sh [--json <path>]
#
# Exit code: 0 when the recount completes. This script reports numbers;
# it does not pass or fail a tree. Layer 1 uses its pair extraction
# definition and compares live numbers with the recorded baseline.

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$ROOT" ]; then ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd); fi
cd "$ROOT" || exit 1

JSON_OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --json)
      JSON_OUT="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: sh scripts/gates/recount-baseline.sh [--json <path>]"
      exit 0
      ;;
    *)
      echo "recount-baseline: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t recount-baseline)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

# Pair extraction identical to scripts/platform-guard.sh check 1.
: > "$tmpdir/pairs.txt"
grep -rln --include='*.ts' --include='*.tsx' \
  -e '@tauri-apps/' -e 'tauri-plugin-clipboard-api' \
  src --exclude-dir=platform 2>/dev/null | LC_ALL=C sort > "$tmpdir/files-all.txt" || true
while IFS= read -r file; do
  [ -n "$file" ] || continue
  grep -o -e '@tauri-apps/[A-Za-z0-9][A-Za-z0-9/_-]*' \
    -e 'tauri-plugin-clipboard-api' "$file" 2>/dev/null | LC_ALL=C sort -u |
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      echo "$file:$spec" >> "$tmpdir/pairs.txt"
    done
done < "$tmpdir/files-all.txt"
LC_ALL=C sort -u "$tmpdir/pairs.txt" -o "$tmpdir/pairs.txt"

pairs=$(wc -l < "$tmpdir/pairs.txt" | tr -d ' ')
files_incl_vendor=$(wc -l < "$tmpdir/files-all.txt" | tr -d ' ')
files_tauri=$(grep -rln --include='*.ts' --include='*.tsx' '@tauri-apps/' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
lines_tauri=$(grep -rn --include='*.ts' --include='*.tsx' '@tauri-apps/' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
lines_vendor=$(grep -rn --include='*.ts' --include='*.tsx' 'tauri-plugin-clipboard-api' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
files_platform=$(grep -rln --include='*.ts' --include='*.tsx' '@tauri-apps/' src/lib/platform 2>/dev/null | wc -l | tr -d ' ')
lines_platform=$(grep -rn --include='*.ts' --include='*.tsx' '@tauri-apps/' src/lib/platform 2>/dev/null | wc -l | tr -d ' ')
files_all_src=$(grep -rln --include='*.ts' --include='*.tsx' '@tauri-apps/' src 2>/dev/null | wc -l | tr -d ' ')
dynamic_lines=$(grep -rn --include='*.ts' --include='*.tsx' -E "import\(['\"]@tauri-apps/|import\(['\"]tauri-plugin-clipboard-api" src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
store_lines=$(grep -rn --include='*.ts' --include='*.tsx' -E '(^|[^A-Za-z0-9_.])Store\.load[[:space:]]*\(' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
invoke_lines=$(grep -rn --include='*.ts' --include='*.tsx' -E '(^|[^A-Za-z0-9_.])invoke[[:space:]]*(\(|<)' src --exclude-dir=platform 2>/dev/null | grep -v 'plugin-item-list.tsx' | wc -l | tr -d ' ')
internals_files=$(grep -rln --include='*.ts' --include='*.tsx' '__TAURI_INTERNALS__' src 2>/dev/null | grep -v '^src/lib/platform/detect.ts$' | wc -l | tr -d ' ')

echo "recount (tree: $(git rev-parse --short HEAD 2>/dev/null || echo unknown))"
echo "  file:specifier pairs (guard extraction): $pairs"
echo "  files outside platform (@tauri-apps/): $files_tauri"
echo "  files outside platform (incl. vendor): $files_incl_vendor"
echo "  lines outside platform (@tauri-apps/): $lines_tauri"
echo "  lines outside platform (vendor): $lines_vendor"
echo "  files inside src/lib/platform: $files_platform"
echo "  lines inside src/lib/platform: $lines_platform"
echo "  files in all of src/ (@tauri-apps/): $files_all_src"
echo "  dynamic import lines outside platform: $dynamic_lines"
echo "  raw Store.load call lines: $store_lines"
echo "  raw invoke call lines: $invoke_lines"
echo "  internals marker files (excl. detect.ts): $internals_files"

# Per-specifier counts, one line per specifier: spec files lines.
specs="plugin-store plugin-sql plugin-fs plugin-dialog plugin-opener plugin-clipboard-manager plugin-http plugin-os plugin-notification plugin-global-shortcut plugin-shell plugin-process plugin-autostart plugin-updater api/core api/path api/window api/webviewWindow api/event api/app api/image"
echo "  per-specifier (files lines):"
for s in $specs; do
  f=$(grep -rln --include='*.ts' --include='*.tsx' "@tauri-apps/$s" src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
  l=$(grep -rn --include='*.ts' --include='*.tsx' "@tauri-apps/$s" src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
  echo "    @tauri-apps/$s $f $l"
  echo "@tauri-apps/$s $f $l" >> "$tmpdir/per-spec.txt"
done
vf=$(grep -rln --include='*.ts' --include='*.tsx' 'tauri-plugin-clipboard-api' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
vl=$(grep -rn --include='*.ts' --include='*.tsx' 'tauri-plugin-clipboard-api' src --exclude-dir=platform 2>/dev/null | wc -l | tr -d ' ')
echo "    tauri-plugin-clipboard-api $vf $vl"
echo "tauri-plugin-clipboard-api $vf $vl" >> "$tmpdir/per-spec.txt"

if [ -n "$JSON_OUT" ]; then
  head=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  {
    echo "{"
    echo "  \"commit\": \"$head\","
    echo "  \"pairsFileSpecifier\": $pairs,"
    echo "  \"filesOutsidePlatformWithTauriApps\": $files_tauri,"
    echo "  \"filesOutsidePlatformWithTauriAppsOrVendor\": $files_incl_vendor,"
    echo "  \"linesOutsidePlatformWithTauriApps\": $lines_tauri,"
    echo "  \"linesOutsidePlatformVendor\": $lines_vendor,"
    echo "  \"filesInsidePlatformWithTauriApps\": $files_platform,"
    echo "  \"linesInsidePlatformWithTauriApps\": $lines_platform,"
    echo "  \"filesAllSrcWithTauriApps\": $files_all_src,"
    echo "  \"dynamicImportLines\": $dynamic_lines,"
    echo "  \"storeLoadCallLines\": $store_lines,"
    echo "  \"invokeCallLines\": $invoke_lines,"
    echo "  \"internalsFilesOutsideDetect\": $internals_files,"
    echo "  \"perSpecifier\": ["
    first=1
    while read -r spec f l; do
      if [ "$first" -eq 1 ]; then first=0; else echo ","; fi
      printf '    {"specifier": "%s", "files": %s, "lines": %s}' "$spec" "$f" "$l"
    done < "$tmpdir/per-spec.txt"
    echo ""
    echo "  ]"
    echo "}"
  } > "$JSON_OUT"
  echo "recount JSON written to $JSON_OUT"
  if command -v node >/dev/null 2>&1; then
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$JSON_OUT" \
      || { echo "recount-baseline: generated JSON is invalid" >&2; exit 1; }
  fi
fi

exit 0
