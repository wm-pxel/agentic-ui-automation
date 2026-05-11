# Viewer Run URLs Design

## Purpose

Give each workflow run in the local read-only viewer its own browser URL so an
operator can refresh, bookmark, or share a direct link to a specific run.

## Scope

In scope:

- Serve the viewer shell from `/runs`, `/runs/`, and `/runs/<run-id>`.
- Keep `/` working as the default viewer entry point.
- Select the run from the URL path when the app loads.
- Update the URL when the operator selects a different run.
- Support browser back and forward navigation between selected runs.
- Preserve the existing read-only API and artifact routes.
- Update viewer tests and docs.

Out of scope:

- Changing run artifact storage.
- Adding hosted or authenticated sharing.
- Changing artifact API URLs.
- Mutating audit artifacts from the viewer.

## Design

The server continues to own filesystem access and artifact routing. It will
serve the same static app shell for viewer page routes: `/`, `/runs`,
`/runs/`, and `/runs/<encoded-run-id>`. Existing API routes under `/api/runs`
remain unchanged so Markdown and artifact links keep their current contract.

The browser app will read the selected run id from `window.location.pathname`.
If the path contains `/runs/<run-id>` and that run exists, it selects that run.
If the URL is `/`, `/runs`, `/runs/`, or names an unknown run, it falls back to
the newest run from `/api/runs`.

When the operator clicks a run, the client calls `history.pushState` with
`/runs/<encoded-run-id>`, then renders the selection. A `popstate` listener
re-reads the path and re-renders the matching run for browser back and forward.

## Error Handling

Unknown run URLs should not return a server 404 because the client needs the run
list before it can decide whether the run exists. The app should render normally
and fall back to the newest run, matching the current empty or missing-selection
behavior.

API and artifact errors remain unchanged. Unsafe artifact paths and missing
Markdown continue to return the existing JSON errors.

## Testing

Add focused viewer server tests that verify:

- `/runs/<run-id>` serves the app shell.
- The served client code reads the run id from the path, pushes selected run
  URLs, and handles `popstate`.

Run the repository verification commands required by `AGENTS.md` before
claiming completion:

```sh
npm run typecheck
npm test
git diff --check
```

## Self Review

- No placeholders remain.
- The design preserves the audit contract and read-only viewer boundary.
- The path-based URL behavior is explicit for direct load, click navigation,
  and browser history.
