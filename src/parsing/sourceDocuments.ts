import { readFile } from "node:fs/promises";
import { extname, basename } from "node:path";
import JSZip from "jszip";
import type { SourceFormat } from "../domain/schema.js";

export interface SourceDocument {
  path: string;
  name: string;
  format: SourceFormat | "pdf" | "docx";
  text: string;
}

export async function loadSourceDocument(path: string): Promise<SourceDocument> {
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case ".json":
      return sourceDocument(path, "json", bytes.toString("utf8"));
    case ".csv":
      return sourceDocument(path, "csv", bytes.toString("utf8"));
    case ".txt":
      return sourceDocument(path, "text", bytes.toString("utf8"));
    case ".pdf":
      return sourceDocument(path, "pdf", extractPdfText(bytes));
    case ".docx":
      return sourceDocument(path, "docx", await extractDocxText(bytes));
    default:
      throw new Error(`Unsupported intake source extension for AI parsing: ${extension}`);
  }
}

function sourceDocument(path: string, format: SourceDocument["format"], text: string): SourceDocument {
  return {
    path,
    name: basename(path),
    format,
    text,
  };
}

function extractPdfText(bytes: Buffer): string {
  const content = bytes.toString("latin1");
  const textObjects = [...content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((match) => decodePdfString(match[1] ?? ""));
  const arrayTextObjects = [...content.matchAll(/\[((?:.|\n)*?)\]\s*TJ/g)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((item) => decodePdfString(item[1] ?? "")),
  );
  const text = [...textObjects, ...arrayTextObjects].join("\n").trim();
  if (text.length > 0) return text;

  return content
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodePdfString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1");
}

async function extractDocxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("DOCX input did not contain word/document.xml.");
  }

  return documentXml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
