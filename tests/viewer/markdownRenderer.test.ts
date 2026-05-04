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

  it("escapes raw HTML and unsafe javascript URLs", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n[bad](javascript:alert(1))', {
      runId: "run-safe",
    });

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('<a href="#" target="_blank" rel="noreferrer">bad</a>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:alert");
  });
});
