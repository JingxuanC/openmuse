import { z } from "zod";

/**
 * A delegated run's rich result, as `runVerticalAgent` shapes it.
 *
 * Which vertical agents exist is server configuration the app never sees, so a
 * tool result is not recognised by tool name: any result that carries artifacts
 * or sources is one, and everything else falls through to the normal renderer.
 */

const artifactSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  /** Workspace-relative: the proxy serves it, the app never builds a path itself. */
  path: z.string().optional(),
});
const sourceSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
});
const resultSchema = z.object({
  report: z.string().optional(),
  artifacts: z.array(artifactSchema).optional(),
  sources: z.array(sourceSchema).optional(),
});

export interface VerticalArtifact {
  type: string;
  id?: string;
  title: string;
  status?: string;
  path?: string;
}

export interface VerticalSource {
  title?: string;
  url?: string;
}

export interface VerticalResult {
  report?: string;
  artifacts: VerticalArtifact[];
  sources: VerticalSource[];
}

/**
 * Read a tool result as delegated rich output, or `undefined` when it is
 * anything else — a plain report, an error, another tool's JSON.
 */
export function parseVerticalResult(result: unknown): VerticalResult | undefined {
  let value = result;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const artifacts = (parsed.data.artifacts ?? []).map((artifact) => ({
    ...artifact,
    // A delegate that named nothing still produced something; the path is the
    // next most useful label, and its type is better than a blank row.
    title: artifact.title || artifact.path || artifact.type,
  }));
  const sources = parsed.data.sources ?? [];
  if (!artifacts.length && !sources.length) return undefined;
  return {
    ...(parsed.data.report ? { report: parsed.data.report } : {}),
    artifacts,
    sources,
  };
}

/** The proxy path for one artifact: the server holds the token, the app never does. */
export function verticalFilePath(toolName: string, path: string): string {
  return `/api/vertical/${encodeURIComponent(toolName)}/file?path=${encodeURIComponent(path)}`;
}

/** What to save an artifact as: the delegate's own leaf name, never a path. */
export function artifactFileName(path: string): string {
  const name = path.split("/").pop()?.trim() ?? "";
  return name && name !== "." && name !== ".." ? name : "artifact";
}
