import { describe, expect, it } from "vitest";
import { renderRunMarkdown } from "../../src/viewer/markdown.js";

describe("renderRunMarkdown", () => {
  it("renders generated summary Markdown patterns", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-summary",
      markdown: [
        "# Workflow Summary",
        "",
        "- Completed registration",
        "- Wrote audit artifacts",
        "",
        "| Target | Succeeded |",
        "| --- | ---: |",
        "| openmrs | 2 |",
        "",
        "```json",
        '{ "status": "completed" }',
        "```",
      ].join("\n"),
    });

    expect(html).toContain("<h1>Workflow Summary</h1>");
    expect(html).toContain("<li>Completed registration</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td style=\"text-align:right\">2</td>");
    expect(html).toContain("<code class=\"language-json\">");
    expect(html).toContain("&quot;status&quot;: &quot;completed&quot;");
  });

  it("rewrites run-relative links and images to artifact API URLs", () => {
    const html = renderRunMarkdown({
      runId: "run with spaces",
      markdown: [
        "[Report](report.json)",
        "",
        "[Nested file](<input/normalized records.json>)",
        "",
        "[Parent segment](../report.json)",
        "",
        "![Screenshot](<screenshots/first page.png>)",
      ].join("\n"),
    });

    expect(html).toContain('href="/api/runs/run%20with%20spaces/artifact/report.json"');
    expect(html).toContain('href="/api/runs/run%20with%20spaces/artifact/input/normalized%20records.json"');
    expect(html).toContain('href="/api/runs/run%20with%20spaces/artifact/%2E%2E/report.json"');
    expect(html).toContain('src="/api/runs/run%20with%20spaces/artifact/screenshots/first%20page.png"');
  });

  it("escapes raw HTML", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-html",
      markdown: "<script>alert('xss')</script>",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not rewrite absolute URLs, root URLs, or anchors", () => {
    const html = renderRunMarkdown({
      runId: "run-2026-05-04T12-00-00-000Z-absolute",
      markdown: [
        "[External](https://example.com/report.json)",
        "",
        "[Root](/api/status)",
        "",
        "[Anchor](#workflow-summary)",
        "",
        "![Remote](https://example.com/image.png)",
      ].join("\n"),
    });

    expect(html).toContain('href="https://example.com/report.json"');
    expect(html).toContain('href="/api/status"');
    expect(html).toContain('href="#workflow-summary"');
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).not.toContain("/api/runs/run-2026-05-04T12-00-00-000Z-absolute/artifact/https");
    expect(html).not.toContain("/api/runs/run-2026-05-04T12-00-00-000Z-absolute/artifact/%23workflow-summary");
  });
});
