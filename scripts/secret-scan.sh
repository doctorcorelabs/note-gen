#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
# See LICENSE and FORK.md.
#
# Backstop secret scan for the web fork (F1-55; HYGIENE-FORK.md section 5.4).
# The CI secret-scan job runs gitleaks when it is present on the runner and
# falls back to this script otherwise. GitHub-hosted runners do not ship
# gitleaks, so this script is the operative gate there.
#
# Scope: tracked files only (what CI checks out is exactly the committed
# tree). Ignored local files such as a developer .env are not findings;
# a secret becomes a finding the moment it is tracked or lands in a PR.
# Lockfiles are skipped: they hold hashes and registry URLs, not secrets.
# This script itself is skipped: it holds search patterns, not values.
# The gitleaks path still covers both exclusions when it runs.
#
# Output safety: this script prints file paths and pattern labels only.
# It never prints a matched line, so a secret value can never leak into
# a CI log through this scan. Verify a finding by opening the named file.
#
# Exit code: 0 when clean, 1 when any finding is reported.
#
# Known baseline exception (narrow, documented, must not be extended
# without a coordinator decision): src/app/model-config.ts holds one
# upstream shared API key, present since the upstream base commit and
# already public in the upstream repository. Its removal belongs to the
# AD-15 shared-key removal work, not to this scan. The sk- pattern check
# below skips exactly that one file and prints a visible warning when it
# does so. Delete the exception when the key is removed from the fork.
# Never use that key value; treat it as compromised.
#
# Usage: bash scripts/secret-scan.sh   (from anywhere inside the repo)

set -eu

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "secret-scan: not inside a git repository" >&2
  exit 1
}
cd "$ROOT"

findings=0
exception_hit=0

report() {
  # $1 = label, $2 = file path. Values are never printed.
  echo "FINDING [$1] $2" >&2
  findings=$((findings + 1))
}

# Forbidden tracked file names: real env files, and upstream plaintext
# stores that must never be committed (HYGIENE-FORK.md section 5.4).
# Only the exact name .env.example is allowed among .env variants.
for f in $(git ls-files); do
  case "$f" in
    *.env.example)
      ;;
    *.env|*.env.*)
      case "$f" in
        */.env|*/.env.*|.env|.env.*) report "forbidden-env-file" "$f" ;;
      esac
      ;;
  esac
  case "$f" in
    store.json|*/store.json) report "forbidden-file" "$f" ;;
    local-mcp.json|*/local-mcp.json) report "forbidden-file" "$f" ;;
    app-lock.json|*/app-lock.json) report "forbidden-file" "$f" ;;
  esac
done

tmp_list=$(mktemp)
trap 'rm -f "$tmp_list"' EXIT INT TERM

# Generic value-pattern scan over tracked text files. Candidate files
# come from git grep; .env.example files are excluded here because their
# placeholder values are checked separately below.
scan_pattern() {
  # $1 = label, $2 = extended regex
  git grep -I -l -E -e "$2" -- ':!pnpm-lock.yaml' ':!server/pnpm-lock.yaml' ':!scripts/secret-scan.sh' > "$tmp_list" || true
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      *.env.example) continue ;;
    esac
    report "$1" "$f"
  done < "$tmp_list"
}

scan_pattern "token-prefix" 'ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_.-]{10,}|AKIA[0-9A-Z]{16}'
scan_pattern "private-key" '-----BEGIN [A-Z ]*PRIVATE KEY-----'
scan_pattern "database-url" 'postgres(ql)?://[^:/<>[:space:]]+:[^@<>[:space:]]+@'

# API key pattern with the single documented baseline exception.
git grep -I -l -E -e 'sk-[A-Za-z0-9]{20,}' -- ':!pnpm-lock.yaml' ':!server/pnpm-lock.yaml' ':!scripts/secret-scan.sh' > "$tmp_list" || true
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.env.example) continue ;;
    src/app/model-config.ts)
      exception_hit=1
      continue
      ;;
  esac
  report "api-key" "$f"
done < "$tmp_list"

# Named fork secrets assigned a real-looking value outside example files.
# Lines carrying the CHANGE_ME placeholder or an angle-bracket placeholder
# are not findings; any other assigned value is. Matched lines are piped
# through filters only and are never printed.
#
# Test fixtures are not findings: an assignment whose target is a TEST_-
# prefixed constant (for example TEST_AUTH_SECRET in server/test/) is a
# labeled test-only value, never a production secret (AD-45 verdict for
# the auth fixtures; coordinator decision AD-55, 15 November 2026). The
# TEST_ filter below drops exactly those lines; any other assignment to
# a secret name still flags. The filter requires a non-identifier
# character (or line start) before TEST_, so names such as
# MY_AUTH_SECRET or XTEST_AUTH_SECRET still flag.
secret_assign="(AUTH_SECRET|SECRETS_ENCRYPTION_KEY|SETUP_TOKEN|INTERNAL_SERVICE_TOKEN|CF_ACCESS_AUD)[[:space:]]*=[[:space:]]*[\"']?[^[:space:]#\"']"
test_assign="(^|[^A-Z0-9_])TEST_(AUTH_SECRET|SECRETS_ENCRYPTION_KEY|SETUP_TOKEN|INTERNAL_SERVICE_TOKEN|CF_ACCESS_AUD)[[:space:]]*="
git grep -I -l -E -e "$secret_assign" -- ':!pnpm-lock.yaml' ':!server/pnpm-lock.yaml' ':!scripts/secret-scan.sh' > "$tmp_list" || true
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.env.example) continue ;;
  esac
  if grep -E "$secret_assign" "$f" | grep -v 'CHANGE_ME' | grep -v '<[^>]*>' | grep -vE "$test_assign" | grep -q .; then
    report "secret-assignment" "$f"
  fi
done < "$tmp_list"

# Example env files: every secret-named assignment must use a CHANGE_ME
# placeholder. A real-looking value in an example file is a finding.
for f in $(git ls-files '*.env.example'); do
  if grep -E '^(AUTH_SECRET|SECRETS_ENCRYPTION_KEY|SETUP_TOKEN|INTERNAL_SERVICE_TOKEN|CF_ACCESS_AUD|DATABASE_URL|POSTGRES_PASSWORD)[[:space:]]*=' "$f" | grep -v 'CHANGE_ME' | grep -q .; then
    report "example-without-placeholder" "$f"
  fi
done

if [ "$exception_hit" -eq 1 ]; then
  echo "WARNING: known baseline exception applied to src/app/model-config.ts (upstream shared key, AD-15 removal pending). Delete the exception when the key is removed." >&2
fi

if [ "$findings" -gt 0 ]; then
  echo "secret-scan: $findings finding(s). Do not merge. If a real secret leaked, rotate it immediately; deleting the file in a later commit does not clean git history." >&2
  exit 1
fi

echo "secret-scan: clean (tracked files, no values printed)."
exit 0
