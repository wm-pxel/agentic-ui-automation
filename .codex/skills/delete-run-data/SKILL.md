---
name: delete-run-data
description: Use when the user asks to delete, clear, clean, reset, or remove existing workflow run data/artifacts in this agentic-ui-automation repo. Deletes generated run directories only, especially runs/, while preserving source, config, dependencies, and demo input data.
---

# Delete Run Data

Use this skill to clear generated workflow run artifacts from this repository.

## Scope

Delete:

- `runs/`

Do not delete:

- `.env`
- `data/`
- `node_modules/`
- `src/`
- `tests/`
- `README.md`, `docs/`, `AGENTS.md`
- Any tracked files under `runs/` if they ever appear

## Workflow

1. From the repo root, inspect run data:

   ```sh
   bash .codex/skills/delete-run-data/scripts/delete-run-data.sh --dry-run
   ```

2. If the dry run shows only ignored/untracked generated run data, delete it:

   ```sh
   bash .codex/skills/delete-run-data/scripts/delete-run-data.sh
   ```

3. Verify `runs/` is gone:

   ```sh
   find . -maxdepth 1 -name runs -print
   ```

4. Report what was deleted. Do not run tests for this cleanup unless the user asks.

