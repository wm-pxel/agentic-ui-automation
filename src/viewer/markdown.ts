import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";

export interface RenderRunMarkdownInput {
  runId: string;
  markdown: string;
}

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});

const defaultLinkOpen =
  markdownRenderer.renderer.rules.link_open ??
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
const defaultImage =
  markdownRenderer.renderer.rules.image ??
  ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

markdownRenderer.renderer.rules.link_open = rewriteAttributeRenderer("href", defaultLinkOpen);
markdownRenderer.renderer.rules.image = rewriteAttributeRenderer("src", defaultImage);

export function renderRunMarkdown(input: RenderRunMarkdownInput): string {
  return markdownRenderer.render(input.markdown, { runId: input.runId });
}

function rewriteAttributeRenderer(attributeName: string, fallback: RenderRule): RenderRule {
  return (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const value = token.attrGet(attributeName);
    const runId = renderEnvRunId(env);
    if (value && runId) {
      const rewritten = rewriteArtifactUrl(runId, value);
      if (rewritten) token.attrSet(attributeName, rewritten);
    }

    return fallback(tokens, idx, options, env, self);
  };
}

function renderEnvRunId(env: unknown): string | undefined {
  if (!isRecord(env)) return undefined;
  return typeof env.runId === "string" ? env.runId : undefined;
}

function rewriteArtifactUrl(runId: string, url: string): string | null {
  if (!shouldRewriteUrl(url)) return null;

  const [path, suffix] = splitPathAndSuffix(url);
  const encodedPath = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodePathSegment(segment))
    .join("/");
  if (!encodedPath) return null;

  return `/api/runs/${encodeURIComponent(runId)}/artifact/${encodedPath}${suffix}`;
}

function shouldRewriteUrl(url: string): boolean {
  return !(
    url.length === 0 ||
    url.startsWith("/") ||
    url.startsWith("#") ||
    url.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(url)
  );
}

function splitPathAndSuffix(url: string): [path: string, suffix: string] {
  const suffixStart = Math.min(...[url.indexOf("?"), url.indexOf("#")].filter((index) => index >= 0));
  if (!Number.isFinite(suffixStart)) return [url, ""];
  return [url.slice(0, suffixStart), url.slice(suffixStart)];
}

function encodePathSegment(segment: string): string {
  try {
    return encodeDecodedPathSegment(decodeURIComponent(segment));
  } catch {
    return encodeDecodedPathSegment(segment);
  }
}

function encodeDecodedPathSegment(segment: string): string {
  if (segment === ".") return "%2E";
  if (segment === "..") return "%2E%2E";
  return encodeURIComponent(segment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
