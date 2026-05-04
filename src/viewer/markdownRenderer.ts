export interface RenderMarkdownOptions {
  runId: string;
}

type ResolvedUrl =
  | { href: string; kind: "anchor" }
  | { href: string; kind: "external" };

export function renderMarkdown(markdown: string, options: RenderMarkdownOptions): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== "```") {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const classAttribute = language ? ` class="language-${escapeAttribute(language)}"` : "";
      blocks.push(`<pre><code${classAttribute}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      const { html, nextIndex } = renderTable(lines, index, options);
      blocks.push(html);
      index = nextIndex;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      blocks.push(`<h${level} id="${escapeAttribute(slugify(text))}">${renderInline(text, options)}</h${level}>`);
      index += 1;
      continue;
    }

    if (isBulletLine(line)) {
      const { html, nextIndex } = renderBulletList(lines, index, options);
      blocks.push(html);
      index = nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^```/.test(lines[index] ?? "") &&
      !/^(#{1,6})\s+/.test(lines[index] ?? "") &&
      !isBulletLine(lines[index] ?? "") &&
      !isTableStart(lines, index)
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraphLines.join(" "), options)}</p>`);
  }

  return blocks.join("\n");
}

function renderBulletList(
  lines: string[],
  startIndex: number,
  options: RenderMarkdownOptions,
): { html: string; nextIndex: number } {
  const items: Array<{ level: number; text: string }> = [];
  let index = startIndex;

  while (index < lines.length) {
    const bullet = parseBulletLine(lines[index] ?? "");
    if (!bullet) break;
    items.push(bullet);
    index += 1;
  }

  let itemIndex = 0;
  function renderLevel(level: number): string {
    let html = "<ul>";
    while (itemIndex < items.length) {
      const item = items[itemIndex];
      if (!item || item.level < level) break;
      if (item.level > level) {
        html += renderLevel(level + 1);
        continue;
      }

      html += `<li>${renderInline(item.text, options)}`;
      itemIndex += 1;
      while (itemIndex < items.length && (items[itemIndex]?.level ?? 0) > level) {
        html += renderLevel(level + 1);
      }
      html += "</li>";
    }
    return `${html}</ul>`;
  }

  return { html: renderLevel(0), nextIndex: index };
}

function renderTable(lines: string[], startIndex: number, options: RenderMarkdownOptions): { html: string; nextIndex: number } {
  const headers = parseTableCells(lines[startIndex] ?? "");
  const alignments = parseTableCells(lines[startIndex + 1] ?? "").map((cell) => (/-+:$/.test(cell) ? "right" : "left"));
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length && isTableRow(lines[index] ?? "")) {
    rows.push(parseTableCells(lines[index] ?? ""));
    index += 1;
  }

  const headerHtml = headers
    .map((header, columnIndex) => renderTableCell("th", header, alignments[columnIndex], options))
    .join("");
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell, columnIndex) => renderTableCell("td", cell, alignments[columnIndex], options)).join("")}</tr>`)
    .join("");

  return {
    html: `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
    nextIndex: index,
  };
}

function renderTableCell(
  tagName: "td" | "th",
  value: string,
  alignment: string | undefined,
  options: RenderMarkdownOptions,
): string {
  const classAttribute = alignment === "right" ? ' class="align-right"' : "";
  return `<${tagName}${classAttribute}>${renderInline(value, options)}</${tagName}>`;
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index] ?? "") && isTableDivider(lines[index + 1] ?? "");
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isTableDivider(line: string): boolean {
  const cells = parseTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  const start = trimmed.startsWith("|") ? 1 : 0;
  const end = trimmed.endsWith("|") ? trimmed.length - 1 : trimmed.length;
  const cells: string[] = [];
  let cell = "";

  for (let index = start; index < end; index += 1) {
    const character = trimmed[index];
    const nextCharacter = trimmed[index + 1];
    if (character === "\\" && nextCharacter === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }

  cells.push(cell.trim());
  return cells;
}

function isBulletLine(line: string): boolean {
  return parseBulletLine(line) !== null;
}

function parseBulletLine(line: string): { level: number; text: string } | null {
  const match = line.match(/^(\s*)-\s+(.+)$/);
  if (!match) return null;
  return {
    level: match[1].length > 0 ? 1 : 0,
    text: match[2].trim(),
  };
}

function renderInline(markdown: string, options: RenderMarkdownOptions): string {
  const pattern = /(!?\[([^\]]*)\]\(([^)]*)\))|`([^`]+)`/g;
  let html = "";
  let lastIndex = 0;

  for (const match of markdown.matchAll(pattern)) {
    html += escapeHtml(markdown.slice(lastIndex, match.index));
    if (match[4] !== undefined) {
      html += `<code>${escapeHtml(match[4])}</code>`;
    } else {
      const fullMatch = match[1] ?? "";
      const label = match[2] ?? "";
      const rawUrl = match[3] ?? "";
      if (fullMatch.startsWith("!")) {
        html += renderImage(label, rawUrl, options);
      } else {
        html += renderLink(label, rawUrl, options);
      }
    }
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  html += escapeHtml(markdown.slice(lastIndex));
  return html;
}

function renderLink(label: string, rawUrl: string, options: RenderMarkdownOptions): string {
  const resolved = resolveMarkdownUrl(rawUrl, options);
  const linkText = renderInline(label, options);
  if (resolved.kind === "anchor") {
    return `<a href="${escapeAttribute(resolved.href)}">${linkText}</a>`;
  }
  return `<a href="${escapeAttribute(resolved.href)}" target="_blank" rel="noreferrer">${linkText}</a>`;
}

function renderImage(alt: string, rawUrl: string, options: RenderMarkdownOptions): string {
  const resolved = resolveMarkdownUrl(rawUrl, options);
  return `<img src="${escapeAttribute(resolved.href)}" alt="${escapeAttribute(alt)}">`;
}

function resolveMarkdownUrl(rawUrl: string, options: RenderMarkdownOptions): ResolvedUrl {
  const url = rawUrl.trim();
  if (url.startsWith("#") && !url.includes("\0")) {
    return { href: url, kind: "anchor" };
  }
  if (url.includes("\0") || url.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    if (/^https?:\/\//i.test(url)) return { href: url, kind: "external" };
    return { href: "#", kind: "external" };
  }
  if (url === "" || /^[A-Za-z]:[\\/]/.test(url)) {
    return { href: "#", kind: "external" };
  }

  return {
    href: `/api/runs/${encodeURIComponent(options.runId)}/artifact/${encodeArtifactPath(url)}`,
    kind: "external",
  };
}

function encodeArtifactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
