import type { CloudProvider, ExecReceipt } from "../../apps/server/src/cloud/provider.ts";
import type { Config } from "../../apps/server/src/config.ts";
import { AppError } from "../../apps/server/src/errors.ts";
import { config as base } from "./computer.ts";

export const config: Config = {
  ...base,
  cloudEnabled: true,
  daytonaApiKey: "daytona-test-key",
  daytonaApiUrl: "https://daytona.test/api",
  cloudCpu: 4,
  cloudMemoryGb: 8,
  cloudDiskGb: 10,
  cloudAutoStopMinutes: 30,
  cloudExecTimeoutMs: 600000,
};
export const ok = (stdout = "hello\n"): ExecReceipt => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  interrupted: false,
  truncated: false,
});

/**
 * An in-memory CloudProvider, so the service's lifecycle semantics are tested without a sandbox.
 * Every call is recorded, which is how the tests assert the create/labels/env contract.
 */
export function fixture(
  options: {
    state?: "running" | "stopped" | "absent" | "error";
    exec?: () => Promise<ExecReceipt>;
    files?: Record<string, string>;
  } = {},
) {
  const calls = {
    start: 0,
    stop: 0,
    status: 0,
    exec: [] as { command: string; cwd: string; timeoutMs: number }[],
  };
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  let state = options.state ?? "running";
  const provider: CloudProvider = {
    async status() {
      calls.status += 1;
      return state;
    },
    async start() {
      calls.start += 1;
      state = "running";
    },
    async stop() {
      calls.stop += 1;
      state = "stopped";
    },
    async exec(_owner, command, cwd, timeoutMs) {
      calls.exec.push({ command, cwd, timeoutMs });
      return options.exec ? options.exec() : ok();
    },
    async readFile(_owner, path) {
      const text = files.get(path);
      if (text === undefined) throw new AppError("Cloud file operation failed", 422);
      return { path, text };
    },
    async writeFile(_owner, path, text) {
      files.set(path, text);
      return { path };
    },
    async listDir(_owner, path) {
      return {
        path,
        entries: [...files.keys()]
          .filter((file) => file.startsWith(`${path}/`))
          .map((file) => ({
            name: file.slice(path.length + 1),
            path: file,
            type: "file" as const,
            size: 1,
          })),
      };
    },
  };
  return {
    provider,
    calls,
    files,
    state: () => state,
    setState: (next: typeof state) => (state = next),
  };
}
