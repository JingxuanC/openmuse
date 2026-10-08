/** One command's durable receipt, shaped like ComputerCommand so the app reuses its rendering. */
export interface CloudCommand {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "interrupted";
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt?: string;
}
export interface CloudSnapshot {
  enabled: boolean;
  provider: "daytona";
  status: "unconfigured" | "stopped" | "running" | "error";
  workspacePath: "/home/daytona";
  /** Unlike the sandbox tier the cloud computer has controlled outbound network (P2b allowlist). */
  network: "enabled";
  spec: { cpu: number; memoryGb: number; diskGb: number };
  message?: string;
  commands: CloudCommand[];
}
export interface CloudDirectory {
  path: string;
  entries: { name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[];
}
