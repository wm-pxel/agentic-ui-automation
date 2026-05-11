# Viewer Run URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clean path-based URLs for each run in the local viewer.

**Architecture:** The HTTP server serves the existing app shell for page routes under `/runs`. The browser app owns run selection, reads the initial run id from the URL path, updates history on selection, and reselects on browser history navigation.

**Tech Stack:** Node HTTP server, TypeScript, plain browser JavaScript, Vitest.

---

### Task 1: Server Page Routes

**Files:**
- Modify: `src/viewer/server.ts`
- Test: `tests/viewer/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add an assertion to the existing app shell server test:

```ts
const runShell = await fetchText(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
expect(runShell).toContain("Agentic UI Run Viewer");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: FAIL because `/runs/<run-id>` currently returns `{ "error": "Not found." }`.

- [ ] **Step 3: Write minimal implementation**

In `src/viewer/server.ts`, route `/runs`, `/runs/`, and `/runs/<run-id>` to `INDEX_HTML` before API route matching.

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: PASS.

### Task 2: Client URL Selection And History

**Files:**
- Modify: `src/viewer/server.ts`
- Test: `tests/viewer/server.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the client-code test to assert the script contains URL selection and history behavior:

```ts
expect(script).toContain("selectedRunId = selectedRunIdFromPath() || runs[0]?.runId || \"\";");
expect(script).toContain("window.history.pushState({}, \"\", runUrl(run.runId));");
expect(script).toContain("window.addEventListener(\"popstate\", async () => {");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: FAIL because the client always selects the newest run and does not update history.

- [ ] **Step 3: Write minimal implementation**

Update the inline browser script so `loadRuns()` initializes from `selectedRunIdFromPath()`, click handlers push `/runs/<run-id>`, and `popstate` reselects from the path.

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
npm test -- tests/viewer/server.test.ts
```

Expected: PASS.

### Task 3: Docs And Required Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md`

- [ ] **Step 1: Update docs**

Mention that the viewer supports direct per-run URLs such as:

```text
http://127.0.0.1:4173/runs/<run-id>
```

- [ ] **Step 2: Run focused viewer tests**

Run:

```sh
npm test -- tests/viewer/server.test.ts tests/viewer/artifactService.test.ts tests/viewer/markdownRenderer.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run:

```sh
npm run typecheck
npm test
git diff --check
```

Expected: all commands exit 0.
