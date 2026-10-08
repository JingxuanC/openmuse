import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CloudDirectory } from "../../../../packages/domain/src/cloud.ts";
import { type Config, cloudDefaults } from "../config.ts";
import { AppError } from "../errors.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Where the sandbox user lives. The stock toolbox image's account is `daytona`
 * (probe-verified: `whoami` → daytona, `HOME` → /home/daytona), so the closed
 * env sets HOME here and every path hangs off it.
 */
export const cloudRoot = "/home/daytona";

export const cloudFileLimit = 256 * 1024;
export const cloudOutputLimit = 128 * 1024;

/** The sandbox env is a closed set: three variables that describe a login shell and no secret. */
export const cloudEnv: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: cloudRoot,
  LANG: "C.UTF-8",
};

export interface ExecReceipt {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  truncated: boolean;
}

/**
 * A per-user cloud sandbox. docker-local is the second implementation this is shaped for: the
 * lifecycle, lease and receipt semantics live in CloudComputerService, so swapping the provider
 * leaves them untouched.
 */
export interface CloudProvider {
  status(owner: string): Promise<"running" | "stopped" | "absent" | "error">;
  /** Creates the sandbox from the configured spec when absent, then starts it. */
  start(owner: string): Promise<void>;
  stop(owner: string): Promise<void>;
  exec(
    owner: string,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecReceipt>;
  readFile(owner: string, path: string): Promise<{ path: string; text: string }>;
  writeFile(owner: string, path: string, text: string): Promise<{ path: string }>;
  listDir(owner: string, path: string): Promise<CloudDirectory>;
}

/**
 * Same derivation as computerIdentity, with `-cloud` and the `cloud-v1` managed label separating
 * the tier. The labels are what stop one deployment from attaching to another's sandbox.
 */
export function cloudIdentity(config: Config, owner: string) {
  const deployment = hash(config.computerDeploymentId ?? config.publicUrl).slice(0, 16);
  const ownerHash = hash(owner).slice(0, 24);
  return {
    sandbox: `openmuse-${deployment}-${ownerHash}-cloud`,
    /**
     * The org-level snapshot all of this deployment's sandboxes are created
     * from. Hosted Daytona rejects per-sandbox resources — sizes are baked
     * into a snapshot (probe-verified), so the tier lives here, not in the
     * sandbox create call. The image version is part of the name: changing what
     * the snapshot is built from must build a new one rather than silently keep
     * serving sandboxes from the old image.
     */
    snapshot: `openmuse-cloud-${deployment}-v${config.cloudImageVersion ?? cloudDefaults.imageVersion}`,
    labels: {
      "dev.openmuse.managed": "cloud-v1",
      "dev.openmuse.deployment": deployment,
      "dev.openmuse.owner": ownerHash,
    } as Record<string, string>,
  };
}

/** The cloud computer's /workspace: an absolute path under the sandbox home, never a traversal. */
export function cloudPath(path: string): string {
  if (
    path.includes("\0") ||
    path.length > 2048 ||
    !path.startsWith(cloudRoot) ||
    path.split("/").includes("..")
  )
    throw new AppError(`Choose an absolute path inside ${cloudRoot}`, 422);
  const normalized = posix.normalize(path);
  if (normalized !== cloudRoot && !normalized.startsWith(`${cloudRoot}/`))
    throw new AppError(`Choose an absolute path inside ${cloudRoot}`, 422);
  return normalized;
}
