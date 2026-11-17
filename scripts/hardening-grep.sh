#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Hardening regression gate (AD-15, gelombang 4). Proves the shared-key and
# Config Center removal stays removed: deleted paths stay deleted, removed
# identifiers stay absent, and the only remaining references to the sponsor
# gateway are the two purge predicates that delete stored sponsor configs.
#
# Usage:
#   bash scripts/hardening-grep.sh                # source checks (tracked files)
#   bash scripts/hardening-grep.sh --bundle out   # production bundle checks
#
# Output safety: this script prints file paths and pattern labels only.
# It never prints a matched line. Exit code: 0 when clean, 1 on any finding.

set -eu

MODE="source"
BUNDLE_DIR=""

if [ "${1:-}" = "--bundle" ]; then
  MODE="bundle"
  BUNDLE_DIR="${2:-}"
  if [ -z "$BUNDLE_DIR" ]; then
    echo "hardening-grep: --bundle requires a directory argument" >&2
    exit 1
  fi
elif [ $# -gt 0 ]; then
  echo "hardening-grep: unknown argument: $1" >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "hardening-grep: not inside a git repository" >&2
  exit 1
}
cd "$ROOT"

findings=0

report() {
  # $1 = label, $2 = file path. Values are never printed.
  echo "FINDING [$1] $2" >&2
  findings=$((findings + 1))
}

if [ "$MODE" = "bundle" ]; then
  if [ ! -d "$BUNDLE_DIR" ]; then
    echo "hardening-grep: bundle directory does not exist: $BUNDLE_DIR" >&2
    exit 1
  fi
  if [ -z "$(find "$BUNDLE_DIR" -type f | head -n 1)" ]; then
    echo "hardening-grep: bundle directory is empty: $BUNDLE_DIR" >&2
    exit 1
  fi
  bundle_hits=$(mktemp)
  trap 'rm -f "$bundle_hits"' EXIT INT TERM
  # The purge predicates keep the bare gateway hostname in the bundle by
  # design, so the bundle gate checks the full request URL form, the
  # Config Center path, and the removed client identifiers only. Docs and
  # plugin/update constants that mention other notegen.top hosts are out
  # of scope here; they never build a gateway request.
  for pattern in 'https://api.notegen.top' 'download.notegen.top/config' 'config-center' 'ConfigCenter' 'fetchConfigCenterConfig'; do
    if grep -r -l -F -- "$pattern" "$BUNDLE_DIR" > "$bundle_hits" 2>/dev/null; then
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        report "bundle-forbidden:$pattern" "$f"
      done < "$bundle_hits"
    fi
  done
  rm -f "$bundle_hits"
  if [ "$findings" -gt 0 ]; then
    echo "hardening-grep: $findings bundle finding(s). Do not merge." >&2
    exit 1
  fi
  echo "hardening-grep: bundle clean ($BUNDLE_DIR, no values printed)."
  exit 0
fi

# --- Source mode: deleted paths must stay deleted (AD-15). ---
for path in \
  src/app/model-config.ts \
  src/lib/config-center/client.ts \
  src/lib/config-center/types.ts \
  src/lib/ai/notegen-default-models-runtime.ts \
  src/lib/ai/notegen-model-policy.ts \
  src/lib/ai/sponsored-model-limits.ts \
  src/hooks/use-notegen-limited-usage.ts \
  src/components/notegen-model-label.tsx \
  src/app/core/setting/ai/default-models.tsx \
  config/notegen-model-policy.json \
  config/notegen-default-models.json \
  config/config-manifest.json
do
  if [ -e "$path" ]; then
    report "deleted-path-present" "$path"
  fi
done
if [ -d src/lib/config-center ]; then
  report "deleted-path-present" "src/lib/config-center"
fi

# --- Pinned bundle and review record must exist. ---
for path in \
  config/provider-templates.json \
  config/provider-templates-cn.json \
  config/recommended-skills.json \
  config/PIN-REVIEW.md \
  .gitguardian.yaml
do
  if [ ! -f "$path" ]; then
    report "required-file-missing" "$path"
  fi
done

# --- Zero-match identifiers in code, config, messages, scripts, CI. ---
# Scoped paths only: prose in docs and infra runbooks may name the removed
# features when documenting the removal. The gate script itself is excluded
# because it holds the patterns, not usages. Disabled workflows (*.disabled)
# are excluded: GitHub never runs them, and rewiring the dead Config Center
# publish workflow belongs to deploy cleanup, not to this removal.
# Legacy store key names noteGenDefaultModelsCache and noteGenModelPolicyCache
# in key-schema/classification files are intentionally not flagged: they
# classify stale cache keys as local-only, and removing registry entries is
# key-schema work, not AD-15. The gate flags the deleted module import path
# (app/model-config) instead of the bare noteGenDefaultModels identifier.
# Spec files are excluded: tests must name the removed identifiers and the
# gateway URL to prove the purge works; a spec importing a deleted module
# still fails typecheck and build. config/PIN-REVIEW.md is excluded: the
# review record names the deleted bundle files on purpose.
zero_patterns='fetchConfigCenterConfig|config-center|ConfigCenter|download\.notegen\.top/config|notegen-model-policy|notegen-default-models|sponsored-model-limits|useNoteGenLimitedUsage|notegen-model-label|noteGenModelDisplayName|NoteGenModelLabel|getCachedProviderTemplates|noteGenModelKeys|app/model-config|DEFAULT_NOTEGEN_MODELS|NOTEGEN_MODEL_POLICY|NOTEGEN_API_BASE_URL|reserveSponsoredRequest|createSponsoredUsageRecorder|https://api\.notegen\.top|getProviderPromotion|ProviderPromotionText|providerSponsor|noteGenLimited|noteGenFree'
tmp_list=$(mktemp)
trap 'rm -f "$tmp_list"' EXIT INT TERM
git grep -I -l -E -e "$zero_patterns" -- src server config scripts messages .github ':!scripts/hardening-grep.sh' ':!*.disabled' ':!*.spec.*' ':!config/PIN-REVIEW.md' > "$tmp_list" || true
while IFS= read -r f; do
  [ -n "$f" ] || continue
  report "removed-identifier" "$f"
done < "$tmp_list"

# --- templateSource must never be 'remote' again. ---
git grep -I -l -E -e "templateSource[[:space:]]*(===|:)[[:space:]]*'remote'|templateSource\??:[[:space:]]*'builtin'[[:space:]]*\|[[:space:]]*'remote'" -- src server config ':!scripts/hardening-grep.sh' > "$tmp_list" || true
while IFS= read -r f; do
  [ -n "$f" ] || continue
  report "template-source-remote" "$f"
done < "$tmp_list"

# --- Sponsor gateway hostname: exactly the two purge predicates. ---
# The predicate literal is allowlisted in exactly two files, one line each.
# Spec files are excluded: tests name the gateway to prove the purge works.
host_files=$(git grep -I -l -F -e 'api.notegen.top' -- src server config ':!*.spec.*' ':!scripts/hardening-grep.sh' || true)
host_count=$(git grep -I -c -F -e 'api.notegen.top' -- src server config ':!*.spec.*' ':!scripts/hardening-grep.sh' 2>/dev/null | awk -F: '{s += $NF} END {print s + 0}')
for f in $host_files; do
  case "$f" in
    src/stores/setting.ts|src/lib/sync/settings-snapshot.ts) ;;
    *) report "gateway-host-outside-purge" "$f" ;;
  esac
done
if [ "$host_count" -ne 2 ]; then
  echo "FINDING [gateway-host-count] expected exactly 2 purge-predicate lines, found $host_count" >&2
  findings=$((findings + 1))
fi

# --- Sponsor model/provider ids: only inside the two purge files. ---
id_files=$(git grep -I -l -E -e 'note-gen-free|note-gen-chat|note-gen-embedding|note-gen-stt|note-gen-limited|note-gen-vlm' -- src server config ':!*.spec.*' ':!scripts/hardening-grep.sh' || true)
for f in $id_files; do
  case "$f" in
    src/stores/setting.ts|src/lib/sync/settings-snapshot.ts) ;;
    *) report "sponsor-id-outside-purge" "$f" ;;
  esac
done

# --- Pinned bundles must carry no sponsored/promotion fields. ---
for bundle in config/provider-templates.json config/provider-templates-cn.json; do
  if git grep -q -F -e '"sponsored"' -- "$bundle" 2>/dev/null; then
    report "bundle-sponsored-field" "$bundle"
  fi
  if git grep -q -F -e '"promotion"' -- "$bundle" 2>/dev/null; then
    report "bundle-promotion-field" "$bundle"
  fi
done

if [ "$findings" -gt 0 ]; then
  echo "hardening-grep: $findings finding(s). Do not merge." >&2
  exit 1
fi

echo "hardening-grep: clean (tracked files, no values printed)."
exit 0
