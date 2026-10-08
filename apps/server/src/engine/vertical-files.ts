import { Hono } from "hono";
import type { Auth } from "../auth.ts";
import type { Config, VerticalAgentSpec } from "../config.ts";
import { AppError } from "../errors.ts";
import type { VerticalRichEvents } from "./vertical-events.ts";

/**
 * The artifact proxy for delegated work.
 *
 * A delegate writes its files into its own LangAlpha workspace, where the only
 * way to read them back is a token-authenticated API on the same identity
 * system. The app cannot hold that token and should not: this route spends the
 * caller's own bearer on both hops, so LangAlpha answers for the right account
 * and the credential never leaves the server.
 */

/** Response headers worth keeping: what the bytes are, and what to call them. */
const passthroughHeaders = ["content-type", "content-disposition", "cache-control", "etag"];

/**
 * A workspace-relative path and nothing else: an absolute path is the sandbox's
 * own, and `..` is how a relative one would climb out of the workspace. The
 * delegate validates again on its side; this is the first gate, not the only one.
 */
export function isWorkspacePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("..");
}

/**
 * The API root the configured AG-UI endpoint hangs off. Read from the endpoint
 * rather than configured twice, and kept as a prefix so a gateway mounted under
 * one still resolves.
 */
export function verticalApiBase(aguiUrl: string): string {
  const index = aguiUrl.indexOf("/api/v1/");
  return index > 0 ? aguiUrl.slice(0, index) : new URL(aguiUrl).origin;
}

interface WorkspaceList {
  workspaces?: { workspace_id?: unknown }[];
}

/** The caller's workspace, read with the caller's token; the two are 1:1. */
export async function findWorkspace(
  request: typeof fetch,
  base: string,
  authorization: string,
): Promise<string> {
  // `custom` is the delegate's own recency ordering, the same one its AG-UI
  // gateway uses to pick the workspace a run lands in.
  const response = await request(`${base}/api/v1/workspaces?limit=1&sort_by=custom`, {
    headers: { Authorization: authorization },
  });
  if (!response.ok) throw new AppError("The delegate's workspace is unavailable", 502);
  let body: WorkspaceList;
  try {
    body = (await response.json()) as WorkspaceList;
  } catch {
    throw new AppError("The delegate's workspace is unavailable", 502);
  }
  const id = body?.workspaces?.[0]?.workspace_id;
  if (typeof id !== "string" || !id)
    throw new AppError("This account has no workspace to read files from", 404);
  return id;
}

export interface VerticalFileOptions {
  /** Overridden by tests; production always uses the network fetch. */
  fetch?: typeof fetch;
}

/** Extensions a person would open: deliverables, not the scripts that built them. */
const deliverableExtensions = [
  "html",
  "htm",
  "csv",
  "tsv",
  "png",
  "jpg",
  "jpeg",
  "svg",
  "pdf",
  "xlsx",
  "md",
];
/** A run that produced more than this has a card problem, not a completeness problem. */
const sweepLimit = 20;

/**
 * Post-run sweep for deliverables that never got an artifact frame.
 *
 * A delegate that writes its report by *running* a builder script emits frames
 * for the script, not for the report — which is exactly the file the person
 * wants to open. The directories its artifacts touched are known, so listing
 * them after the run recovers the deliverables. Best-effort: a listing failure
 * changes nothing, because the frames that did arrive still stand.
 */
export async function sweepDeliverables(
  spec: VerticalAgentSpec,
  authorization: string,
  rich: VerticalRichEvents,
  options: VerticalFileOptions = {},
): Promise<void> {
  const directories = rich.directories();
  if (!directories.length) return;
  const request = options.fetch ?? fetch;
  const base = verticalApiBase(spec.url);
  let workspace: string;
  try {
    workspace = await findWorkspace(request, base, authorization);
  } catch {
    return;
  }
  let added = 0;
  for (const dir of directories) {
    if (added >= sweepLimit) return;
    let files: unknown;
    try {
      const response = await request(
        `${base}/api/v1/workspaces/${encodeURIComponent(workspace)}/files?path=${encodeURIComponent(dir)}&pattern=${encodeURIComponent("**/*")}`,
        { headers: { Authorization: authorization } },
      );
      if (!response.ok) continue;
      files = (await response.json())?.files;
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (added >= sweepLimit) return;
      if (typeof file !== "string") continue;
      const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
      if (!deliverableExtensions.includes(extension)) continue;
      const before = rich.summary().artifacts?.length ?? 0;
      rich.collectPath(file);
      added += (rich.summary().artifacts?.length ?? 0) - before;
    }
  }
}

export function verticalFileRoutes(config: Config, auth: Auth, options: VerticalFileOptions = {}) {
  const app = new Hono();
  app.get("/:name/file", async (c) => {
    const authorization = c.req.header("authorization");
    // An expired or missing session is refused before anything is looked up.
    await auth.owner(authorization);
    const spec = (config.verticalAgents ?? []).find((agent) => agent.name === c.req.param("name"));
    if (!spec) throw new AppError("Unknown vertical agent", 404);
    const path = c.req.query("path") ?? "";
    if (!isWorkspacePath(path)) throw new AppError("Choose a file inside the workspace", 400);

    const request = options.fetch ?? fetch;
    const base = verticalApiBase(spec.url);
    const workspace = await findWorkspace(request, base, authorization as string);
    const download = await request(
      `${base}/api/v1/workspaces/${encodeURIComponent(workspace)}/files/download?path=${encodeURIComponent(path)}`,
      { headers: { Authorization: authorization as string } },
    );
    const headers = new Headers();
    for (const name of passthroughHeaders) {
      const value = download.headers.get(name);
      if (value) headers.set(name, value);
    }
    // The delegate decides the status: 200 for the bytes, its own 404 for a path
    // that is not there, 304 when the caller already holds this version. A 304
    // carries no body, and neither does any other bodiless status.
    const bodiless = download.status === 204 || download.status === 304;
    return new Response(bodiless ? null : download.body, { status: download.status, headers });
  });
  return app;
}
