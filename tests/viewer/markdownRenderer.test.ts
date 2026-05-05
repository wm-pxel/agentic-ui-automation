import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/viewer/markdownRenderer.js";

describe("renderMarkdown", () => {
  it("renders generated-summary headings, lists, tables, and fenced code blocks", () => {
    const html = renderMarkdown(
      [
        "# Workflow Run run-1",
        "",
        "- [Artifacts](#artifacts)",
        "- Plain item",
        "",
        "| Target | Succeeded |",
        "| --- | ---: |",
        "| openmrs | 1 |",
        "",
        "```json",
        "{",
        '  "status": "completed"',
        "}",
        "```",
      ].join("\n"),
      { runId: "run-1" },
    );

    expect(html).toContain('<h1 id="workflow-run-run-1">Workflow Run run-1</h1>');
    expect(html).toContain('<a href="#artifacts">Artifacts</a>');
    expect(html).toContain("<li>Plain item</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Target</th>");
    expect(html).toContain('<th class="align-right">Succeeded</th>');
    expect(html).toContain('<code class="language-json">');
    expect(html).toContain("&quot;status&quot;: &quot;completed&quot;");
  });

  it("rewrites run-relative artifact links and images", () => {
    const html = renderMarkdown(
      [
        "[Structured report](report.json)",
        "",
        "![Proof](screenshots/demo-001/openmrs/after-save.png)",
      ].join("\n"),
      { runId: "run-abc" },
    );

    expect(html).toContain(
      '<a href="/api/runs/run-abc/artifact/report.json" target="_blank" rel="noreferrer">Structured report</a>',
    );
    expect(html).toContain(
      '<img src="/api/runs/run-abc/artifact/screenshots/demo-001/openmrs/after-save.png" alt="Proof">',
    );
  });

  it("renders generated-summary nested contents and escaped table pipes", () => {
    const html = renderMarkdown(
      [
        "## Contents",
        "",
        "- [Records](#records)",
        "  - [Record demo-001](#record-demo-001)",
        "",
        "| Field | Value |",
        "| --- | --- |",
        String.raw`| Notes | uses A\|B option |`,
      ].join("\n"),
      { runId: "run-toc" },
    );

    expect(html).toContain('<a href="#records">Records</a>');
    expect(html).toContain('<a href="#record-demo-001">Record demo-001</a>');
    expect(html).toContain("<ul>");
    expect(html).not.toContain('<p>- <a href="#record-demo-001">Record demo-001</a></p>');
    expect(html).toContain("<td>uses A|B option</td>");
    expect(html).not.toContain("<td>uses A\\</td>");
  });

  it("highlights OpenMRS rows that flag below-threshold mapping confidence", () => {
    const html = renderMarkdown(
      [
        "| Intake Field | Status |",
        "| --- | --- |",
        "| sex_at_birth | succeeded; low confidence: 97% below threshold 99% |",
        "| phone | succeeded |",
      ].join("\n"),
      { runId: "run-review" },
    );

    expect(html).toContain('<tr class="attention-row"><td>sex_at_birth</td><td>succeeded; low confidence: 97% below threshold 99%</td></tr>');
    expect(html).toContain("<tr><td>phone</td><td>succeeded</td></tr>");
  });

  it("color-codes issue rows and severity cells from generated summary tables", () => {
    const html = renderMarkdown(
      [
        "| Severity | Record | Target | Phase | Code | Message | Remediation | Evidence |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| error | demo-001 | openmrs | target | verification_failed | Save could not be verified. | Review the after-save screenshot. | screenshots/demo-001/openmrs/after-save.png |",
        "| warning | demo-002 | fake | validation | invalid_format | Optional field was malformed. | Correct the source field. |  |",
      ].join("\n"),
      { runId: "run-issues" },
    );

    expect(html).toContain('<tr class="severity-row severity-error">');
    expect(html).toContain('<td class="severity-cell severity-error"><span class="severity-badge severity-error">Error</span></td>');
    expect(html).toContain('<tr class="severity-row severity-warning">');
    expect(html).toContain('<td class="severity-cell severity-warning"><span class="severity-badge severity-warning">Warning</span></td>');
    expect(html).toContain("Review the after-save screenshot.");
  });

  it("escapes raw HTML and unsafe javascript URLs", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n[bad](javascript:alert(1))', {
      runId: "run-safe",
    });

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">bad</a>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:alert");
  });

  it("applies URL policy for anchors, external URLs, and unsafe paths", () => {
    const html = renderMarkdown(
      [
        "[Anchor](#record-demo-001)",
        "[External](https://example.test/report?run=1)",
        "[Root](/api/secrets)",
        "[Absolute file](/tmp/report.json)",
        "[Windows drive](C:\\Users\\demo\\report.json)",
        "[Nul](screenshots/demo\0after.png)",
      ].join("\n\n"),
      { runId: "run-policy" },
    );

    expect(html).toContain('<a href="#record-demo-001">Anchor</a>');
    expect(html).toContain(
      '<a href="https://example.test/report?run=1" target="_blank" rel="noreferrer">External</a>',
    );
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">Root</a>');
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">Absolute file</a>');
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">Windows drive</a>');
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">Nul</a>');
  });
});
