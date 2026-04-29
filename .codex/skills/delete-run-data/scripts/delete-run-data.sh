#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash .codex/skills/delete-run-data/scripts/delete-run-data.sh [--dry-run]

Deletes generated workflow run data from this repository:
  runs/

The script refuses to delete runs/ if any file under it is tracked by git.
EOF
}

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
elif [[ $# -gt 0 ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f package.json ]] || ! grep -q '"name": "agentic-ui-automation"' package.json; then
  echo "Refusing to run: current directory does not look like the agentic-ui-automation repo root." >&2
  exit 1
fi

if [[ ! -e runs ]]; then
  echo "No runs/ directory found."
  exit 0
fi

tracked_files="$(git ls-files runs || true)"
if [[ -n "$tracked_files" ]]; then
  echo "Refusing to delete runs/: tracked files exist under runs/." >&2
  echo "$tracked_files" >&2
  exit 1
fi

size="$(du -sh runs 2>/dev/null | awk '{print $1}')"
if [[ "$dry_run" -eq 1 ]]; then
  echo "Would delete runs/ (${size:-unknown size})."
  exit 0
fi

rm -rf runs
echo "Deleted runs/ (${size:-unknown size})."
