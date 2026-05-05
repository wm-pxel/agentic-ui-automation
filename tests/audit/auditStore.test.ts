import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAuditStore } from "../../src/audit/auditStore.js";
import { renderExecutiveSummary, renderSummary } from "../../src/audit/summary.js";

describe("FileAuditStore", () => {
  it("writes events, screenshots, exceptions, and summary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-"));
    const store = await FileAuditStore.create({
      runsDir: root,
      runId: "run-test",
      now: () => "2026-04-28T12:00:00.000Z",
    });

    await store.writeEvent({
      phase: "adapter",
      actionType: "click",
      recordId: "demo-001",
      target: "fake",
      result: "clicked Save",
    });
    const screenshotPath = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("png"));
    const exceptionPath = await store.writeException("demo-001", {
      code: "verification_failed",
      severity: "error",
      message: "Could not verify save.",
      suggestedRemediation: "Review target screen.",
    });
    await store.writeSummary("# Summary\n");
    await store.writeExecutiveSummary("# Executive Summary\n");

    expect(screenshotPath).toContain("screenshots/demo-001/fake/after-save.png");

    const events = await readFile(join(root, "run-test", "events.jsonl"), "utf8");
    expect(events).toContain("\"actionType\":\"click\"");
    expect(events).toContain("\"timestamp\":\"2026-04-28T12:00:00.000Z\"");

    const exception = await readFile(join(root, "run-test", exceptionPath), "utf8");
    expect(exception).toContain("verification_failed");

    const summary = await readFile(join(root, "run-test", "summary.md"), "utf8");
    expect(summary).toBe("# Summary\n");

    const executiveSummary = await readFile(join(root, "run-test", "executive-summary.md"), "utf8");
    expect(executiveSummary).toBe("# Executive Summary\n");
  });

  it("collects structured report details and writes parseable report JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-report-"));
    const store = await FileAuditStore.create({
      runsDir: root,
      runId: "run-test",
      now: () => "2026-04-28T12:00:00.000Z",
    });

    await store.writeFieldMapping({
      recordId: "demo-001",
      target: "openmrs",
      sourceField: "sexOrGender",
      targetField: "Birth Sex",
      normalizedValue: "Female",
      selectorCandidates: ['select[name="form_sex"]', 'select[name="sex"]'],
      selectedSelector: 'select[name="form_sex"]',
      action: "select",
      status: "succeeded",
    });
    await store.writeAiExtraction({
      recordId: "demo-001",
      model: "gpt-test",
      sourceDocumentName: "intake.txt",
      fields: [
        {
          sourceField: "firstName",
          sourceLabel: "given_name",
          value: "Ava",
          confidence: 0.96,
          evidence: "Name: Ava Nguyen",
        },
      ],
      additionalFields: [
        {
          sourceField: "employer",
          sourceLabel: "employer",
          value: "Acme",
          confidence: 0.7,
          evidence: "Employer: Acme",
        },
      ],
      issues: [],
    });
    await store.writeRecordInput({
      recordId: "demo-001",
      sourceFormat: "json",
      rawInput: {
        intake_id: "demo-001",
        patient: {
          given_name: "Ava",
          surname: "Nguyen",
        },
      },
    });
    await store.writeTargetEvidence({
      recordId: "demo-001",
      target: "openmrs",
      status: "succeeded",
      screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
      fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
      targetRecordId: "openmrs-demo-001",
      message: "submitted OpenMRS patient form",
    });
    await store.writeReportIssue({
      phase: "target",
      target: "openmrs",
      recordId: "demo-001",
      severity: "error",
      exceptionCode: "verification_failed",
      message: "OpenMRS still showed the new-patient form after save.",
      suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
      screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
    });
    await store.writeReportJson({
      runId: "run-test",
      status: "completed_with_exceptions",
      totalRecords: 1,
      counts: {
        preflightExceptions: 0,
        environmentExceptions: 0,
        closeExceptions: 0,
        targetCounts: { openmrs: { succeeded: 0, exception: 1, skipped: 0 } },
      },
      details: store.getReportDetails(),
    });

    expect(store.getReportDetails()).toEqual({
      fieldMappings: [
        {
          recordId: "demo-001",
          target: "openmrs",
          sourceField: "sexOrGender",
          targetField: "Birth Sex",
          normalizedValue: "Female",
          selectorCandidates: ['select[name="form_sex"]', 'select[name="sex"]'],
          selectedSelector: 'select[name="form_sex"]',
          action: "select",
          status: "succeeded",
        },
      ],
      recordInputs: [
        {
          recordId: "demo-001",
          sourceFormat: "json",
          rawInput: {
            intake_id: "demo-001",
            patient: {
              given_name: "Ava",
              surname: "Nguyen",
            },
          },
        },
      ],
      targetEvidence: [
        {
          recordId: "demo-001",
          target: "openmrs",
          status: "succeeded",
          screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
          fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
          targetRecordId: "openmrs-demo-001",
          message: "submitted OpenMRS patient form",
        },
      ],
      aiExtractions: [
        {
          recordId: "demo-001",
          model: "gpt-test",
          sourceDocumentName: "intake.txt",
          fields: [
            {
              sourceField: "firstName",
              sourceLabel: "given_name",
              value: "Ava",
              confidence: 0.96,
              evidence: "Name: Ava Nguyen",
            },
          ],
          additionalFields: [
            {
              sourceField: "employer",
              sourceLabel: "employer",
              value: "Acme",
              confidence: 0.7,
              evidence: "Employer: Acme",
            },
          ],
          issues: [],
        },
      ],
      issues: [
        {
          phase: "target",
          target: "openmrs",
          recordId: "demo-001",
          severity: "error",
          exceptionCode: "verification_failed",
          message: "OpenMRS still showed the new-patient form after save.",
          suggestedRemediation: "Review required fields and the after-save screenshot before retrying.",
          screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
        },
      ],
    });

    const report = JSON.parse(await readFile(join(root, "run-test", "report.json"), "utf8"));
    expect(report.details.fieldMappings[0]).toMatchObject({
      sourceField: "sexOrGender",
      targetField: "Birth Sex",
      normalizedValue: "Female",
      selectedSelector: 'select[name="form_sex"]',
      action: "select",
      status: "succeeded",
    });
    expect(report.details.aiExtractions[0]).toMatchObject({
      recordId: "demo-001",
      fields: [{ sourceField: "firstName", value: "Ava", confidence: 0.96 }],
    });
    expect(report.details.issues[0]).toMatchObject({
      severity: "error",
      exceptionCode: "verification_failed",
      screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
    });
    expect(report.details.recordInputs[0]).toMatchObject({
      recordId: "demo-001",
      rawInput: { intake_id: "demo-001" },
    });
    expect(report.details.targetEvidence[0]).toMatchObject({
      recordId: "demo-001",
      target: "openmrs",
      status: "succeeded",
      screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
      fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
    });
  });

  it("preserves OpenMRS field confirmation metadata in reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-field-confirmation-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    await store.writeFieldMapping({
      recordId: "demo-001",
      target: "openmrs",
      sourceField: "phone",
      targetField: "Phone Number",
      normalizedValue: "+13125550198",
      mappingConfidence: 0.99,
      selectorCandidates: ['input[name="phoneNumber"]'],
      selectedSelector: 'input[name="phoneNumber"]',
      action: "fill",
      status: "succeeded",
      agentConfidence: 0.62,
      confidenceThreshold: 0.8,
      agentRationale: "The visible label could refer to another contact field.",
      approvalSource: "operator_edited",
      originalProposedValue: "+13125550198",
      finalValue: "+13125550999",
    });

    await store.writeFieldMapping({
      recordId: "demo-001",
      target: "openmrs",
      sourceField: "streetAddress",
      targetField: "Address Line 1",
      normalizedValue: "1200 West Lake Street",
      mappingConfidence: 0.98,
      selectorCandidates: ['input[name="address1"]'],
      status: "skipped",
      agentConfidence: 0.55,
      confidenceThreshold: 0.8,
      agentRationale: "The optional address field was not clearly visible.",
      approvalSource: "operator_skipped",
      skipReason: "Operator skipped optional field.",
    });

    const report = store.buildReport({
      status: "completed",
      totalRecords: 1,
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      targetCounts: { openmrs: { succeeded: 1, exception: 0, skipped: 0 } },
    });

    expect(report.details.fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "phone",
        approvalSource: "operator_edited",
        originalProposedValue: "+13125550198",
        finalValue: "+13125550999",
      }),
    );
    expect(report.details.fieldMappings).toContainEqual(
      expect.objectContaining({
        sourceField: "streetAddress",
        status: "skipped",
        approvalSource: "operator_skipped",
        skipReason: "Operator skipped optional field.",
      }),
    );
  });

  it("writes parseable JSONL events with the expected fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-jsonl-"));
    const store = await FileAuditStore.create({
      runsDir: root,
      runId: "run-test",
      now: () => "2026-04-28T12:00:00.000Z",
    });

    await store.writeEvent({
      phase: "adapter",
      actionType: "verify",
      recordId: "demo-001",
      target: "fake",
      result: "verified save",
      exceptionCode: "verification_failed",
    });

    const events = await readFile(join(root, "run-test", "events.jsonl"), "utf8");
    const lines = events.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      timestamp: "2026-04-28T12:00:00.000Z",
      runId: "run-test",
      phase: "adapter",
      actionType: "verify",
      recordId: "demo-001",
      target: "fake",
      result: "verified save",
      exceptionCode: "verification_failed",
    });
  });

  it("rejects traversal run IDs and nested input artifact names", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-paths-"));

    await expect(FileAuditStore.create({ runsDir: root, runId: "../escape" })).rejects.toThrow("runId");
    await expect(FileAuditStore.create({ runsDir: root, runId: "///" })).rejects.toThrow("runId");

    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    await expect(store.writeInputArtifact("../x", "bad")).rejects.toThrow("input artifact name");
    await expect(store.writeInputArtifact("folder/x", "bad")).rejects.toThrow("input artifact name");
  });

  it("keeps repeated screenshots with unique paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-screenshots-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    const first = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("one"));
    const second = await store.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("two"));

    expect(first).not.toBe(second);
    expect(first).toContain("screenshots/demo-001/fake/after-save");
    expect(second).toContain("screenshots/demo-001/fake/after-save");
    await expect(readFile(join(root, "run-test", first), "utf8")).resolves.toBe("one");
    await expect(readFile(join(root, "run-test", second), "utf8")).resolves.toBe("two");
  });

  it("sanitizes record IDs for screenshot and exception artifact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-record-paths-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    const screenshotPath = await store.writeScreenshot("case/001", "fake", "before/save", Buffer.from("png"));
    const exceptionPath = await store.writeException("", {
      code: "verification_failed",
      severity: "error",
      message: "Missing source ID.",
    });

    expect(screenshotPath).toBe("screenshots/case-001/fake/before-save.png");
    expect(exceptionPath).toBe("exceptions/record.json");
    await expect(readFile(join(root, "run-test", screenshotPath), "utf8")).resolves.toBe("png");
    await expect(readFile(join(root, "run-test", exceptionPath), "utf8")).resolves.toContain("Missing source ID.");
  });

  it("keeps repeated screenshots across reopened stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-resumed-screenshots-"));
    const firstStore = await FileAuditStore.create({ runsDir: root, runId: "run-test" });
    const first = await firstStore.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("one"));

    const secondStore = await FileAuditStore.create({ runsDir: root, runId: "run-test" });
    const second = await secondStore.writeScreenshot("demo-001", "fake", "after-save", Buffer.from("two"));

    expect(first).not.toBe(second);
    await expect(readFile(join(root, "run-test", first), "utf8")).resolves.toBe("one");
    await expect(readFile(join(root, "run-test", second), "utf8")).resolves.toBe("two");
  });

  it("keeps repeated exceptions with unique paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-exceptions-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    const first = await store.writeException("demo-001", {
      code: "verification_failed",
      severity: "error",
      message: "First failure.",
    });
    const second = await store.writeException("demo-001", {
      code: "environment_not_ready",
      severity: "error",
      message: "Second failure.",
    });

    expect(first).not.toBe(second);
    await expect(readFile(join(root, "run-test", first), "utf8")).resolves.toContain("First failure.");
    await expect(readFile(join(root, "run-test", second), "utf8")).resolves.toContain("Second failure.");
  });

  it("keeps repeated exceptions across reopened stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-resumed-exceptions-"));
    const firstStore = await FileAuditStore.create({ runsDir: root, runId: "run-test" });
    const first = await firstStore.writeException("demo-001", {
      code: "verification_failed",
      severity: "error",
      message: "First failure.",
    });

    const secondStore = await FileAuditStore.create({ runsDir: root, runId: "run-test" });
    const second = await secondStore.writeException("demo-001", {
      code: "environment_not_ready",
      severity: "error",
      message: "Second failure.",
    });

    expect(first).not.toBe(second);
    await expect(readFile(join(root, "run-test", first), "utf8")).resolves.toContain("First failure.");
    await expect(readFile(join(root, "run-test", second), "utf8")).resolves.toContain("Second failure.");
  });

  it("validates audit events at runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "audit-events-"));
    const store = await FileAuditStore.create({ runsDir: root, runId: "run-test" });

    await expect(
      store.writeEvent({
        phase: "adapter",
        actionType: "verify",
        result: "invalid exception code",
        exceptionCode: "not-a-code" as never,
      }),
    ).rejects.toThrow();
  });

  it("renders status counts in Markdown", () => {
    const summary = renderSummary({
      runId: "run-test",
      runDir: "runs/run-test",
      sourceInputPath: "data/demo/intake-records.json",
      totalRecords: 2,
      targetCounts: {
        openmrs: { succeeded: 1, exception: 1, skipped: 0 },
        fake: { succeeded: 2, exception: 0, skipped: 0 },
      },
      preflightExceptions: 1,
      environmentExceptions: 2,
      closeExceptions: 1,
    });

    expect(summary).toContain("# Workflow Run run-test");
    expect(summary).toContain("## Contents");
    expect(summary).toContain("- [Artifacts](#artifacts)");
    expect(summary).toContain("- [Target Counts](#target-counts)");
    expect(summary).toContain("- [Issues](#issues)");
    expect(summary).toContain("## Artifacts");
    expect(summary).toContain("## Target Counts");
    expect(summary).toContain("| Source input | data/demo/intake-records.json |");
    expect(summary).toContain("| Normalized records | runs/run-test/input/normalized-records.json |");
    expect(summary).toContain("| Exceptions | runs/run-test/exceptions/ |");
    expect(summary).toContain("| Screenshots | runs/run-test/screenshots/ |");
    expect(summary).toContain("| Event log | runs/run-test/events.jsonl |");
    expect(summary).toContain("| Executive summary | runs/run-test/executive-summary.md |");
    expect(summary).toContain("| Structured report | runs/run-test/report.json |");
    expect(summary).not.toContain("| Run directory |");
    expect(summary).not.toContain("| Summary |");
    expect(summary).not.toContain("| Run metadata |");
    expect(summary.indexOf("| Source input |")).toBeLessThan(summary.indexOf("| Normalized records |"));
    expect(summary.indexOf("| Normalized records |")).toBeLessThan(summary.indexOf("| Exceptions |"));
    expect(summary.indexOf("| Exceptions |")).toBeLessThan(summary.indexOf("| Screenshots |"));
    expect(summary.indexOf("| Screenshots |")).toBeLessThan(summary.indexOf("| Event log |"));
    expect(summary.indexOf("| Event log |")).toBeLessThan(summary.indexOf("| Executive summary |"));
    expect(summary.indexOf("| Executive summary |")).toBeLessThan(summary.indexOf("| Structured report |"));
    expect(summary).toContain("| openmrs | 1 | 1 | 0 |");
    expect(summary).toContain("Preflight exceptions: 1");
    expect(summary).toContain("Environment exceptions: 2");
    expect(summary).toContain("Close exceptions: 1");
  });

  it("renders OpenMRS record review with intake input, screenshots, and side-by-side field comparisons", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 1,
      targetCounts: {
        openmrs: { succeeded: 0, exception: 1, skipped: 0 },
      },
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      details: {
        recordInputs: [
          {
            recordId: "demo-001",
            sourceFormat: "json",
            rawInput: {
              intake_id: "demo-001",
              phone: "3125550198",
              patient: {
                given_name: "Ava",
                sex_at_birth: "female",
              },
            },
          },
        ],
        targetEvidence: [
          {
            recordId: "demo-001",
            target: "openmrs",
            status: "succeeded",
            screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
            fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
            targetRecordId: "openmrs-demo-001",
            message: "submitted OpenMRS patient form",
          },
        ],
        aiExtractions: [
          {
            recordId: "demo-001",
            model: "gpt-test",
            sourceDocumentName: "intake.txt",
            fields: [
              {
                sourceField: "firstName",
                sourceLabel: "given_name",
                value: "Ava",
                confidence: 0.96,
                evidence: "Name: Ava Nguyen",
              },
              {
                sourceField: "sexOrGender",
                sourceLabel: "sex_at_birth",
                value: "female",
                confidence: 0.94,
                evidence: "sex_at_birth: female",
              },
              {
                sourceField: "state",
                sourceLabel: "province",
                value: "IL",
                confidence: 0.93,
                evidence: "province: IL",
              },
            ],
            additionalFields: [],
            issues: [],
          },
        ],
        issues: [
          {
            phase: "target",
            target: "openmrs",
            recordId: "demo-001",
            severity: "error",
            exceptionCode: "verification_failed",
            message: "OpenMRS still showed the new-patient form after save.",
            suggestedRemediation: "Review required fields.",
            screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
          },
        ],
        fieldMappings: [
          {
            recordId: "demo-001",
            target: "openmrs",
            sourceField: "sexOrGender",
            targetField: "Birth Sex",
            normalizedValue: "Female",
            mappingConfidence: 0.97,
            selectorCandidates: ['select[name="form_sex"]', 'select[name="sex"]'],
            selectedSelector: 'select[name="form_sex"]',
            action: "select",
            status: "succeeded",
            confidenceThreshold: 0.99,
            approvalSource: "operator_confirmed",
          },
          {
            recordId: "demo-001",
            target: "openmrs",
            sourceField: "state",
            targetField: "State",
            normalizedValue: "Illinois",
            mappingConfidence: 0.96,
            selectorCandidates: ['input[name="form_state"]', 'select[name="form_state"]'],
            selectedSelector: 'select[name="form_state"]',
            action: "select",
            status: "succeeded",
          },
          {
            recordId: "demo-001",
            target: "openmrs",
            sourceField: "phone",
            targetField: "Phone Number",
            normalizedValue: "+13125550198",
            mappingConfidence: 0.99,
            selectorCandidates: ['input[name="phoneNumber"]'],
            selectedSelector: 'input[name="phoneNumber"]',
            action: "fill",
            status: "succeeded",
            agentConfidence: 0.62,
            confidenceThreshold: 0.8,
            agentRationale: "The visible label could refer to another contact field.",
            approvalSource: "operator_edited",
            originalProposedValue: "+13125550198",
            finalValue: "",
          },
          {
            recordId: "demo-001",
            target: "openmrs",
            sourceField: "streetAddress",
            targetField: "Address Line 1",
            normalizedValue: "1200 West Lake Street",
            mappingConfidence: 0.98,
            selectorCandidates: ['input[name="address1"]'],
            status: "skipped",
            approvalSource: "operator_skipped",
            skipReason: "Operator skipped optional field.",
          },
        ],
      },
    });

    expect(summary).toContain("## Issues");
    expect(summary).toContain("- [OpenMRS Record Review](#openmrs-record-review)");
    expect(summary).toContain("  - [Record demo-001](#record-demo-001)");
    expect(summary).toContain("| Severity | Count |");
    expect(summary).toContain("| error | 1 |");
    expect(summary).toContain("| error | demo-001 | openmrs | target | verification_failed | OpenMRS still showed the new-patient form after save. | Review required fields. | screenshots/demo-001/openmrs/after-save.png |");
    expect(summary).toContain("## OpenMRS Record Review");
    expect(summary).toContain("### Record demo-001");
    expect(summary).toContain("#### Intake Input");
    expect(summary).toContain("\"intake_id\": \"demo-001\"");
    expect(summary).toContain("#### Screenshots");
    expect(summary).not.toContain("![OpenMRS filled fields screenshot for demo-001](screenshots/demo-001/openmrs/after-fill.png)");
    expect(summary).toContain("![OpenMRS proof screenshot for demo-001](screenshots/demo-001/openmrs/after-save.png)");
    expect(summary).toContain("#### Intake to OpenMRS Comparison");
    expect(summary).toContain("Rows highlighted yellow in the viewer indicate OpenMRS mappings whose confidence is below the configured threshold.");
    expect(summary).toContain("| Intake Field | Intake Value | Mapping Confidence | Normalized Field | OpenMRS Field | AI-Mapped Value | Final Input Value | Action | Status | Selector or Error |");
    expect(summary).not.toContain("Intake Evidence");
    expect(summary).toContain("| sex_at_birth | female | 0.97; user confirmed | sexOrGender | Birth Sex | Female | Female | select | succeeded; low confidence: 97% below threshold 99%; operator_confirmed | select[name=\"form_sex\"] |");
    expect(summary).toContain("| province | IL | 0.96 | state | State | Illinois | Illinois | select | succeeded | select[name=\"form_state\"] |");
    expect(summary).toContain("| phone | 3125550198 | 0.99; user edited | phone | Phone Number | +13125550198 |  | fill | succeeded; operator_edited; agent 62%; threshold 80%; proposed +13125550198; final <empty>; rationale The visible label could refer to another contact field. | input[name=\"phoneNumber\"] |");
    expect(summary).toContain("| streetAddress |  | 0.98; user skipped | streetAddress | Address Line 1 | 1200 West Lake Street |  |  | skipped; operator_skipped; Operator skipped optional field. |  |");
    expect(summary).toContain("| given_name | Ava |  | firstName |  |  |  |  | not mapped |  |");
    expect(summary).not.toContain("## AI Source Extraction");
    expect(summary).not.toContain("## Intake to OpenMRS Field Mapping");
  });

  it("renders a concise executive summary with outcome, counts, key findings, and review links", () => {
    const executiveSummary = renderExecutiveSummary({
      runId: "run-test",
      status: "completed_with_exceptions",
      runDir: "runs/run-test",
      sourceInputPath: "data/demo/intake-records.json",
      totalRecords: 2,
      targetCounts: {
        openmrs: { succeeded: 1, exception: 1, skipped: 0 },
      },
      preflightExceptions: 1,
      environmentExceptions: 0,
      closeExceptions: 0,
      details: {
        recordInputs: [
          {
            recordId: "demo-001",
            sourceFormat: "json",
            rawInput: { intake_id: "demo-001", notes: "raw intake content should stay out of the executive summary" },
          },
        ],
        targetEvidence: [
          {
            recordId: "demo-001",
            target: "openmrs",
            status: "succeeded",
            fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
            targetRecordId: "openmrs-demo-001",
          },
        ],
        aiExtractions: [],
        issues: [
          {
            phase: "target",
            target: "openmrs",
            recordId: "demo-002",
            severity: "error",
            exceptionCode: "verification_failed",
            message: "OpenMRS could not verify the saved patient.",
            suggestedRemediation: "Review the filled-field screenshot.",
            screenshotPath: "screenshots/demo-002/openmrs/after-fill.png",
          },
        ],
        fieldMappings: [
          {
            recordId: "demo-002",
            target: "openmrs",
            sourceField: "state",
            targetField: "State",
            normalizedValue: "Illinois",
            selectorCandidates: ['select[name="form_state"]'],
            status: "failed",
            errorMessage: "No visible selector matched.",
          },
        ],
      },
    });

    expect(executiveSummary).toContain("# Executive Summary run-test");
    expect(executiveSummary).toContain("| Status | completed_with_exceptions |");
    expect(executiveSummary).toContain("| Source records | 2 |");
    expect(executiveSummary).toContain("| Preflight exceptions | 1 |");
    expect(executiveSummary).toContain("| openmrs | 1 | 1 | 0 |");
    expect(executiveSummary).toContain("- 1 issue recorded.");
    expect(executiveSummary).toContain("- 1 OpenMRS field mapping failed.");
    expect(executiveSummary).toContain("- 1 OpenMRS record has screenshot evidence.");
    expect(executiveSummary).toContain("| error | demo-002 | openmrs | target | verification_failed | OpenMRS could not verify the saved patient. | Review the filled-field screenshot. | screenshots/demo-002/openmrs/after-fill.png |");
    expect(executiveSummary).toContain("| Full summary | runs/run-test/summary.md |");
    expect(executiveSummary).toContain("| Structured report | runs/run-test/report.json |");
    expect(executiveSummary).toContain("| Source input | data/demo/intake-records.json |");
    expect(executiveSummary).toContain("| Normalized records | runs/run-test/input/normalized-records.json |");
    expect(executiveSummary).not.toContain("raw intake content should stay out of the executive summary");
    expect(executiveSummary).not.toContain("#### Intake Input");
  });

  it("renders OpenMRS record review when only success evidence is available", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 1,
      targetCounts: {
        openmrs: { succeeded: 1, exception: 0, skipped: 0 },
      },
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      details: {
        recordInputs: [
          {
            recordId: "demo-001",
            sourceFormat: "json",
            rawInput: {
              intake_id: "demo-001",
              patient: {
                given_name: "Ava",
                surname: "Nguyen",
              },
            },
          },
        ],
        targetEvidence: [
          {
            recordId: "demo-001",
            target: "openmrs",
            status: "succeeded",
            screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
            fieldScreenshotPath: "screenshots/demo-001/openmrs/after-fill.png",
            targetRecordId: "openmrs-demo-001",
            message: "submitted OpenMRS patient form",
          },
        ],
        aiExtractions: [],
        issues: [],
        fieldMappings: [],
      },
    });

    expect(summary).toContain("## OpenMRS Record Review");
    expect(summary).toContain("### Record demo-001");
    expect(summary).toContain("#### Screenshots");
    expect(summary).not.toContain("- Filled-field screenshot: screenshots/demo-001/openmrs/after-fill.png");
    expect(summary).not.toContain("![OpenMRS filled fields screenshot for demo-001](screenshots/demo-001/openmrs/after-fill.png)");
    expect(summary).toContain("- Proof screenshot: screenshots/demo-001/openmrs/after-save.png");
    expect(summary).toContain("![OpenMRS proof screenshot for demo-001](screenshots/demo-001/openmrs/after-save.png)");
    expect(summary).toContain("- Target record: openmrs-demo-001");
    expect(summary).toContain("\"intake_id\": \"demo-001\"");
    expect(summary).toContain("\"given_name\": \"Ava\"");
  });

  it("renders OpenMRS failure context screenshots when no filled-field screenshot is available", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 1,
      targetCounts: {
        openmrs: { succeeded: 0, exception: 1, skipped: 0 },
      },
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      details: {
        recordInputs: [],
        targetEvidence: [
          {
            recordId: "demo-001",
            target: "openmrs",
            status: "exception",
            screenshotPath: "screenshots/demo-001/openmrs/before-navigation.png",
            message: "Timed out waiting for visible OpenMRS new patient form.",
          },
        ],
        aiExtractions: [],
        issues: [],
        fieldMappings: [],
      },
    });

    expect(summary).toContain("## OpenMRS Record Review");
    expect(summary).toContain("- Context screenshot: screenshots/demo-001/openmrs/before-navigation.png");
    expect(summary).toContain("![OpenMRS context screenshot for demo-001](screenshots/demo-001/openmrs/before-navigation.png)");
    expect(summary).not.toContain("- Filled-field screenshot:");
  });

  it("renders OpenMRS issue screenshots when exception evidence only exists on issues", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 1,
      targetCounts: {
        openmrs: { succeeded: 0, exception: 1, skipped: 0 },
      },
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      details: {
        recordInputs: [],
        targetEvidence: [],
        aiExtractions: [],
        issues: [
          {
            phase: "target",
            target: "openmrs",
            recordId: "demo-001",
            exceptionCode: "possible_duplicate",
            message: "OpenMRS indicated a possible duplicate patient.",
            screenshotPath: "screenshots/demo-001/openmrs/after-save.png",
          },
        ],
        fieldMappings: [],
      },
    });

    expect(summary).toContain("## OpenMRS Record Review");
    expect(summary).toContain("- Exception screenshot: screenshots/demo-001/openmrs/after-save.png");
    expect(summary).toContain("![OpenMRS exception screenshot for demo-001](screenshots/demo-001/openmrs/after-save.png)");
    expect(summary).toContain("- Result: OpenMRS indicated a possible duplicate patient.");
  });

  it("renders clean no-issue and no-mapping sections for non-OpenMRS runs", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 1,
      targetCounts: {
        fake: { succeeded: 1, exception: 0, skipped: 0 },
      },
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
      details: {
        recordInputs: [],
        targetEvidence: [],
        aiExtractions: [],
        issues: [],
        fieldMappings: [],
      },
    });

    expect(summary).toContain("## Issues\n\nNo issues recorded.");
    expect(summary).not.toContain("## OpenMRS Record Review");
  });

  it("renders target rows in deterministic order", () => {
    const summary = renderSummary({
      runId: "run-test",
      totalRecords: 3,
      targetCounts: {
        fake: { succeeded: 3, exception: 0, skipped: 0 },
        openmrs: { succeeded: 1, exception: 2, skipped: 0 },
      },
      preflightExceptions: 0,
      environmentExceptions: 0,
      closeExceptions: 0,
    });

    expect(summary.indexOf("| openmrs | 1 | 2 | 0 |")).toBeLessThan(summary.indexOf("| fake | 3 | 0 | 0 |"));
  });
});
