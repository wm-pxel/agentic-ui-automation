import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { loadSourceDocument } from "../../src/parsing/sourceDocuments.js";

describe("loadSourceDocument", () => {
  it("loads text source documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-doc-text-"));
    const path = join(dir, "intake.txt");
    await writeFile(path, "Patient: Ava Nguyen");

    await expect(loadSourceDocument(path)).resolves.toMatchObject({
      name: "intake.txt",
      format: "text",
      text: "Patient: Ava Nguyen",
    });
  });

  it("extracts text from DOCX documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-doc-docx-"));
    const path = join(dir, "intake.docx");
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<w:document><w:body>",
        "<w:p><w:r><w:t>Name: Ava Nguyen</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>DOB: 1987-03-14</w:t></w:r></w:p>",
        "</w:body></w:document>",
      ].join(""),
    );
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));

    const document = await loadSourceDocument(path);

    expect(document.format).toBe("docx");
    expect(document.text).toContain("Name: Ava Nguyen");
    expect(document.text).toContain("DOB: 1987-03-14");
  });

  it("extracts simple text-bearing PDF strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "source-doc-pdf-"));
    const path = join(dir, "intake.pdf");
    await writeFile(path, "%PDF-1.4\nBT\n(Name: Ava Nguyen) Tj\n(DOB: 1987-03-14) Tj\nET\n%%EOF");

    const document = await loadSourceDocument(path);

    expect(document.format).toBe("pdf");
    expect(document.text).toContain("Name: Ava Nguyen");
    expect(document.text).toContain("DOB: 1987-03-14");
  });
});
