import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DaytonaProvider } from "../apps/server/src/cloud/daytona.ts";
import { cloudDockerfile } from "../apps/server/src/cloud/image.ts";
import { cloudIdentity } from "../apps/server/src/cloud/provider.ts";
import { CloudComputerService } from "../apps/server/src/cloud/service.ts";
import { cloudTools } from "../apps/server/src/cloud-tools.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { config, fixture, ok } from "./helpers/cloud.ts";

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});

test("a disabled cloud computer reports setup and never reaches the provider", async () => {
  const f = fixture();
  const service = new CloudComputerService(db, { ...config, cloudEnabled: false }, f.provider);
  const snapshot = await service.snapshot("owner");
  assert.equal(snapshot.status, "unconfigured");
  assert.equal(snapshot.enabled, false);
  await assert.rejects(service.execute("owner", { command: "pwd" }), /not configured/);
  assert.equal(f.calls.status + f.calls.start + f.calls.stop + f.calls.exec.length, 0);
});

test("start creates on first use and status maps the provider state", async () => {
  const absent = fixture({ state: "absent" });
  const service = new CloudComputerService(db, config, absent.provider);
  const before = await service.snapshot("started-owner");
  assert.equal(before.status, "stopped");
  assert.deepEqual(before.spec, { cpu: 4, memoryGb: 8, diskGb: 10 });
  assert.equal(before.network, "enabled");
  assert.equal(before.workspacePath, "/home/daytona");
  assert.equal((await service.start("started-owner")).status, "running");
  assert.equal(absent.calls.start, 1);
  const broken = new CloudComputerService(db, config, fixture({ state: "error" }).provider);
  assert.equal((await broken.snapshot("broken-owner")).status, "error");
});

test("a running command holds an atomic lease across service instances", async () => {
  let finish: ((result: ReturnType<typeof ok>) => void) | undefined;
  let started: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture({
    exec: () =>
      new Promise((resolve) => {
        finish = resolve;
        started?.();
      }),
  });
  const first = new CloudComputerService(db, config, f.provider);
  const second = new CloudComputerService(db, config, f.provider);
  const run = first.execute("lease-owner", { command: "sleep 900" });
  await running;
  await assert.rejects(second.execute("lease-owner", { command: "pwd" }), /busy/);
  assert.equal(f.calls.exec.length, 1);
  finish?.(ok());
  assert.equal((await run).status, "succeeded");
});

test("a long command renews its lease until it reports an outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let finish: ((result: ReturnType<typeof ok>) => void) | undefined;
  let started: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture({
    exec: () =>
      new Promise((resolve) => {
        finish = resolve;
        started?.();
      }),
  });
  const service = new CloudComputerService(db, config, f.provider);
  const run = service.execute("renew-owner", { command: "sleep 900" });
  await running;
  const before = await db.get<{ expiresAt: number }>("renew-owner", "cloud-state", "lease");
  t.mock.timers.tick(60000);
  const deadline = Date.now() + 2000;
  let after = await db.get<{ expiresAt: number }>("renew-owner", "cloud-state", "lease");
  while (after && before && after.expiresAt <= before.expiresAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    after = await db.get<{ expiresAt: number }>("renew-owner", "cloud-state", "lease");
  }
  assert.ok(before && after && after.expiresAt > before.expiresAt, "the lease was renewed");
  finish?.(ok());
  assert.equal((await run).status, "succeeded");
});

test("timeouts and interruptions stop the sandbox and stay durable and idempotent", async () => {
  const timedOut = fixture({ exec: async () => ({ ...ok(), timedOut: true, exitCode: null }) });
  const service = new CloudComputerService(db, config, timedOut.provider);
  const first = await service.execute(
    "timeout-owner",
    { command: "sleep 900" },
    { idempotencyKey: "timeout-case" },
  );
  assert.equal(first.status, "timed_out");
  // A lost client cannot cancel the remote process, so the sandbox itself is stopped.
  assert.equal(timedOut.calls.stop, 1);
  assert.equal(timedOut.state(), "stopped");
  assert.deepEqual(
    await service.execute(
      "timeout-owner",
      { command: "sleep 900" },
      { idempotencyKey: "timeout-case" },
    ),
    first,
  );
  assert.equal(timedOut.calls.exec.length, 1);
  await assert.rejects(
    service.execute("timeout-owner", { command: "pwd" }, { idempotencyKey: "timeout-case" }),
    /different command/,
  );
  const interrupted = new CloudComputerService(
    db,
    config,
    fixture({ exec: async () => ({ ...ok(), interrupted: true, exitCode: null }) }).provider,
  );
  assert.equal(
    (await interrupted.execute("interrupt-owner", { command: "sleep 900" })).status,
    "interrupted",
  );
});

test("stop is two-phase: a running command is quarantined before the sandbox is stopped", async () => {
  let finish: ((result: ReturnType<typeof ok>) => void) | undefined;
  let started: (() => void) | undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture({
    exec: () =>
      new Promise((resolve) => {
        finish = resolve;
        started?.();
      }),
  });
  const service = new CloudComputerService(db, config, f.provider);
  const run = service.execute("stop-owner", { command: "sleep 900" });
  await running;
  const stopped = await service.stop("stop-owner");
  assert.equal(stopped.status, "stopped");
  assert.equal(f.calls.stop, 1);
  const receipt = stopped.commands.find((command) => command.status === "running");
  assert.equal(receipt, undefined);
  finish?.({ ...ok(), interrupted: true, exitCode: null });
  assert.equal((await run).status, "interrupted");
  const [persisted] = (await service.snapshot("stop-owner")).commands;
  assert.equal(persisted.status, "interrupted");
  assert.match(persisted.stderr, /Stopped by the user/);
});

test("cloud paths stay inside the sandbox home and files are capped at 256 KB", async () => {
  const f = fixture();
  const service = new CloudComputerService(db, config, f.provider);
  for (const path of [
    "/etc/passwd",
    "/home/daytona-evil",
    "/home/daytona/../../etc/passwd",
    "/workspace",
  ])
    await assert.rejects(service.read("path-owner", path), /inside \/home\/daytona/);
  await assert.rejects(
    service.execute("path-owner", { command: "pwd", cwd: "/etc" }),
    /inside \/home\/daytona/,
  );
  await assert.rejects(
    service.write("path-owner", "/home/daytona/big.txt", "x".repeat(256 * 1024 + 1)),
    /256 KB/,
  );
  await service.write("path-owner", "/home/daytona/notes.txt", "hello");
  assert.equal((await service.read("path-owner", "/home/daytona/notes.txt")).text, "hello");
  assert.deepEqual(
    (await service.list("path-owner", "/home/daytona")).entries.map((entry) => entry.name),
    ["notes.txt"],
  );
  const executed = await service.execute("path-owner", {
    command: "pwd",
    cwd: "/home/daytona/sub",
  });
  assert.equal(executed.status, "succeeded");
  assert.equal(f.calls.exec.at(-1)?.cwd, "/home/daytona/sub");
  assert.equal(f.calls.exec.at(-1)?.timeoutMs, 600000);
});

test("cloud tools exist only when the tier is on and refuse to run without a sandbox", async () => {
  const f = fixture({ state: "absent" });
  const service = new CloudComputerService(db, config, f.provider);
  assert.deepEqual(cloudTools({ ...config, cloudEnabled: false }, service, "owner", "chat"), []);
  const tools = cloudTools(config, service, "owner", "chat:t1");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "cloud_status",
      "cloud_start",
      "cloud_stop",
      "cloud_exec",
      "cloud_list_files",
      "cloud_read_file",
      "cloud_write_file",
    ],
  );
  // An unauthenticated or unconfigured caller is refused instead of reaching a sandbox.
  const refused = await tools[3].execute?.({ command: "pwd", operationId: "op-1" });
  assert.deepEqual(refused, {
    error: "Start the cloud computer before using its terminal or files",
  });
  assert.equal(f.calls.exec.length, 0);
});

test("daytona maps sandbox states and refuses a sandbox from another deployment", async () => {
  assert.equal(await daytona("started").provider.status("owner"), "running");
  assert.equal(await daytona("stopped").provider.status("owner"), "stopped");
  assert.equal(await daytona("error").provider.status("owner"), "error");
  assert.equal(await daytona("destroyed").provider.status("owner"), "absent");
  const untagged = daytona("started", { items: [{ ...sandbox(), labels: {} }] });
  await assert.rejects(untagged.provider.status("owner"), /another deployment/);
  assert.equal((await untagged.provider.status("other-owner")) === "absent", true);
});

test("daytona creates the sandbox from its tier snapshot with the closed env and its labels", async () => {
  const { provider, requests } = daytona("started", { items: [] });
  await provider.start("owner");
  const snapshotCreate = requests.find(
    (request) => request.init?.method === "POST" && request.url.endsWith("/snapshots"),
  );
  assert.ok(snapshotCreate, "the tier snapshot was built once");
  const snapshotBody = JSON.parse(String(snapshotCreate.init?.body));
  // The image version is part of the name, so a new image builds a new snapshot instead of
  // reusing the one the previous image produced.
  assert.match(snapshotBody.name, /^openmuse-cloud-[0-9a-f]{16}-v3$/);
  assert.equal(snapshotBody.name, cloudIdentity(config, "owner").snapshot);
  assert.equal(snapshotBody.imageName, undefined);
  assert.equal(snapshotBody.cpu, 4);
  assert.equal(snapshotBody.memory, 8);
  assert.equal(snapshotBody.disk, 10);
  // The image is built from a Dockerfile so Chromium and the browser CLI are baked in.
  const dockerfile: string = snapshotBody.buildInfo.dockerfileContent;
  assert.match(dockerfile, /^FROM daytonaio\/sandbox:0\.8\.0$/m);
  assert.match(dockerfile, /playwright/);
  assert.match(dockerfile, /om-browser/);
  assert.match(dockerfile, /fonts-noto-cjk/);
  const create = requests.find(
    (request) => request.init?.method === "POST" && request.url.endsWith("/sandbox"),
  );
  assert.ok(create, "the sandbox was created");
  const body = JSON.parse(String(create.init?.body));
  assert.equal(body.snapshot, cloudIdentity(config, "owner").snapshot);
  // Hosted Daytona rejects per-sandbox resources: sizes live only in the snapshot.
  assert.equal(body.cpu, undefined);
  assert.equal(body.memory, undefined);
  assert.equal(body.disk, undefined);
  assert.deepEqual(body.env, {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/daytona",
    LANG: "C.UTF-8",
  });
  assert.equal(Object.keys(body.env).length, 3);
  assert.deepEqual(body.labels, cloudIdentity(config, "owner").labels);
  assert.equal(body.name, cloudIdentity(config, "owner").sandbox);
  assert.equal(body.autoStopInterval, 30);
  assert.equal(body.public, false);
});

test("the cloud image bakes a browser and its CLI into the sandbox", () => {
  const dockerfile = cloudDockerfile();
  // A raw OS image has no toolbox, and every exec and file call runs through it.
  assert.match(dockerfile, /^FROM daytonaio\/sandbox:0\.8\.0$/m);
  assert.match(dockerfile, /fonts-noto-cjk/);
  // The base runs as `daytona`; apt and npm -g need root, and the toolbox needs it back.
  assert.match(dockerfile, /^USER root$/m);
  assert.match(dockerfile, /^USER daytona$/m);
  assert.ok(
    dockerfile.indexOf("USER root") < dockerfile.indexOf("apt-get") &&
      dockerfile.indexOf("apt-get") < dockerfile.lastIndexOf("USER daytona"),
    "the install steps run as root and the image ends as daytona",
  );
  assert.match(dockerfile, /node_modules\/playwright-core\/cli\.js install --with-deps chromium/);
  // Chromium's binaries are downloaded at build time, when HOME is root's, and read at
  // runtime as `daytona`; a shared path is what keeps the two from disagreeing.
  assert.match(dockerfile, /ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  // The CLI is written into the image: a snapshot is built from a Dockerfile alone, with no
  // build context to COPY a second file from.
  assert.ok(dockerfile.includes("> /usr/local/bin/om-browser \\"));
  assert.match(dockerfile, /^ && chmod \+x \/usr\/local\/bin\/om-browser$/m);
  // One persistent profile, owned by the user the toolbox executes commands as.
  assert.ok(dockerfile.includes('const PROFILE = "/home/daytona/.om-browser";'));
  assert.ok(dockerfile.includes("launchPersistentContext(PROFILE, { headless: true })"));
  assert.match(dockerfile, /^RUN mkdir -p \/home\/daytona\/\.om-browser \\$/m);
  assert.match(dockerfile, /^ && chown -R daytona \/home\/daytona\/\.om-browser$/m);
  // The base stays configurable, but the built-in default is the one the toolbox needs.
  assert.match(cloudDockerfile("registry.example/base:1"), /^FROM registry\.example\/base:1$/m);
  assert.match(cloudDockerfile(), /^FROM daytonaio\/sandbox:0\.8\.0$/m);
});

test("daytona sees through the stopped flicker inside the create window", async () => {
  const snapshotName = cloudIdentity(config, "owner").snapshot;
  let listed: Record<string, unknown>[] = [];
  const provider = new DaytonaProvider(config, {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/snapshots"))
        return json({ id: "snap-1", name: snapshotName, state: "active" });
      if (target.includes("/sandbox?")) return json({ items: listed });
      if (init?.method === "POST" && target.endsWith("/sandbox"))
        return json({ ...sandbox(), state: "started" });
      // The by-id GET is what waitFor and the grace re-check read.
      return json({ ...sandbox(), state: "started" });
    }) as typeof globalThis.fetch,
    sleep: async () => {},
    pollMs: 0,
  });
  await provider.start("owner");
  // Probe-verified on hosted Daytona: the list reads "stopped" for a moment even
  // though the create already confirmed "started".
  listed = [{ ...sandbox(), state: "stopped" }];
  assert.equal(await provider.status("owner"), "running");
});

test("daytona replaces a failed snapshot build instead of blocking on it", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const snapshotName = cloudIdentity(config, "owner").snapshot;
  let deleted = false;
  const provider = new DaytonaProvider(config, {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      requests.push({ url: target, init });
      if (target.includes("/snapshots")) {
        if (init?.method === "POST") return json({ id: "snap-new", name: snapshotName, state: "active" });
        if (init?.method === "DELETE") {
          deleted = true;
          return new Response(null, { status: 200 });
        }
        if (target.endsWith(`/snapshots/${snapshotName}`))
          return deleted
            ? json({ message: "not found" }, 404)
            : json({ id: "snap-old", name: snapshotName, state: "error" });
        if (target.endsWith("/snapshots/snap-new"))
          return json({ id: "snap-new", name: snapshotName, state: "active" });
        return json({ message: "not found" }, 404);
      }
      if (init?.method === "POST") return json({ ...sandbox(), state: "started" });
      if (target.includes("/sandbox?")) return json({ items: [] });
      return json({ ...sandbox(), state: "started" });
    }) as typeof globalThis.fetch,
    sleep: async () => {},
    pollMs: 0,
  });
  await provider.start("owner");
  const removed = requests.find(
    (request) => request.init?.method === "DELETE" && request.url.endsWith("/snapshots/snap-old"),
  );
  assert.ok(removed, "the failed snapshot was deleted");
  const rebuilt = requests.find(
    (request) => request.init?.method === "POST" && request.url.endsWith("/snapshots"),
  );
  assert.ok(rebuilt, "a fresh snapshot build was started");
  assert.ok(
    requests.findIndex((r) => r === removed) < requests.findIndex((r) => r === rebuilt),
    "the delete comes before the rebuild",
  );
  // The recreate only happens once the name is actually free, or hosted Daytona 409s.
  const gonePoll = requests.find(
    (request, index) =>
      index > requests.findIndex((r) => r === removed) &&
      index < requests.findIndex((r) => r === rebuilt) &&
      request.url.endsWith(`/snapshots/${snapshotName}`),
  );
  assert.ok(gonePoll, "the name was polled free before the rebuild");
});

test("daytona reports an unreachable or rejected API instead of pretending success", async () => {
  const offline = new DaytonaProvider(config, {
    fetch: (async () => {
      throw new Error("socket closed");
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(offline.status("owner"), /did not respond/);
  const unauthorized = new DaytonaProvider(config, {
    fetch: (async () => json({ message: "bad key" }, 401)) as typeof globalThis.fetch,
  });
  await assert.rejects(unauthorized.status("owner"), /rejected the API key/);
});

function sandbox() {
  const identity = cloudIdentity(config, "owner");
  return { id: "sandbox-1", name: identity.sandbox, state: "started", labels: identity.labels };
}

/** A provider whose Daytona API answers from memory: lists `items`, creates, then starts. */
function daytona(state: string, options: { items?: Record<string, unknown>[] } = {}) {
  const items = options.items ?? [{ ...sandbox(), state }];
  const requests: { url: string; init?: RequestInit }[] = [];
  const provider = new DaytonaProvider(config, {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      requests.push({ url: target, init });
      if (target.includes("/snapshots")) {
        if (init?.method === "POST")
          return json({
            id: "snap-1",
            name: cloudIdentity(config, "owner").snapshot,
            state: "active",
          });
        // The name-addressed GET 404s for an absent snapshot; the id GET reports the build.
        if (target.endsWith("/snapshots/snap-1"))
          return json({
            id: "snap-1",
            name: cloudIdentity(config, "owner").snapshot,
            state: "active",
          });
        return json({ message: "not found" }, 404);
      }
      if (init?.method === "POST") return json({ ...sandbox(), state: "started" });
      if (target.includes("/sandbox?")) return json({ items });
      return json({ ...sandbox(), state });
    }) as typeof globalThis.fetch,
    sleep: async () => {},
    pollMs: 0,
  });
  return { provider, requests };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
