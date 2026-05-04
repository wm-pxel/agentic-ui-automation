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
