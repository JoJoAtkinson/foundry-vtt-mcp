#!/usr/bin/env bash
# The fork's footprint on upstream files, checked against FORK.md (audit mcp-fork-11).
#
#   scripts/fork-footprint.sh [base]     # base defaults to: git merge-base HEAD upstream/master
#
# Prints `git diff --stat` for every upstream file the fork touches outside src/fork/, then
# fails (exit 1) when
#   * a touched file has no row in FORK.md (a new upstream edit landed undocumented), or
#   * a file in FORK.md's `fork:` marker table has a different number of `fork:` markers
#     (a hunk was added or removed in a marked file without updating FORK.md).
# Read-only.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base="${1:-$(git merge-base HEAD upstream/master)}"
excludes=(':!**/fork/**' ':!CHANGELOG.md' ':!package-lock.json' ':!FORK.md' ':!scripts/fork-footprint.sh')

echo "fork footprint vs ${base:0:7} (src/fork/, CHANGELOG.md, package-lock.json, FORK.md excluded):"
git diff --stat "$base"...HEAD -- . "${excludes[@]}"

status=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if ! grep -qF "| \`$path\` |" FORK.md; then
    echo "✗ $path is changed from upstream but has no row in FORK.md" >&2
    status=1
  fi
done < <(git diff --name-only "$base"...HEAD -- . "${excludes[@]}")

# The marker table: rows of `| \`<path>\` | <n> |` under the "fork: markers" heading.
while IFS='|' read -r _ cell count _; do
  path="$(echo "$cell" | tr -d ' `')"
  want="$(echo "$count" | tr -d ' ')"
  [ -f "$path" ] || { echo "✗ FORK.md marker table names $path, which does not exist" >&2; status=1; continue; }
  have="$(grep -c 'fork:' "$path" || true)"
  if [ "$have" != "$want" ]; then
    echo "✗ $path has $have 'fork:' marker(s); FORK.md records $want" >&2
    status=1
  fi
done < <(awk '/^## `fork:` markers/{on=1; next} /^## /{on=0} on && /^\| `/' FORK.md)

if [ "$status" -eq 0 ]; then
  echo "✓ every upstream file the fork touches has a FORK.md row; marker counts match"
fi
exit "$status"
