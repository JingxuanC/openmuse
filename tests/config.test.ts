import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertApiDeploymentConfig,
  browserWorkerUrl,
  type Config,
  defaultSupabaseUrl,
  maxConcurrentPerUser,
  positiveInt,
  shadowedEnvKeys,
} from "../apps/server/src/config.ts";

const sampleConfig: Config = {
  mode: "sample",
  authMode: "local",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

function liveConfig(intelligenceApiKey?: string): Config {
  return {
    ...sampleConfig,
    mode: "live",
    agentBackend: "model",
    intelligenceBackend: "copilotkit",
    intelligenceApiKey,
  };
}

const missingKeyMessage =
  "INTELLIGENCE_BACKEND=copilotkit requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

test("the default local intelligence backend starts without a project key", () => {
  for (const mode of [sampleConfig, { ...sampleConfig, mode: "live" as const }]) {
    for (const key of [undefined, "", " \t\n"]) {
      assert.doesNotThrow(() => assertApiDeploymentConfig({ ...mode, intelligenceApiKey: key }));
    }
  }
});

test("the copilotkit intelligence backend rejects a missing or blank project key", () => {
  for (const mode of [
    liveConfig(),
    { ...sampleConfig, intelligenceBackend: "copilotkit" as const },
  ]) {
    for (const key of [undefined, "", " \t\n"]) {
      assert.throws(() => assertApiDeploymentConfig({ ...mode, intelligenceApiKey: key }), {
        name: "Error",
        message: missingKeyMessage,
      });
    }
  }
});

test("the copilotkit intelligence backend accepts a non-empty project key", () => {
  for (const mode of [
    liveConfig(),
    { ...sampleConfig, intelligenceBackend: "copilotkit" as const },
  ]) {
    assert.doesNotThrow(() =>
      assertApiDeploymentConfig({ ...mode, intelligenceApiKey: "test-project-key-never-sent" }),
    );
  }
});

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
    INTELLIGENCE_BACKEND: process.env.INTELLIGENCE_BACKEND,
  };
  try {
    delete process.env.CPK_INTELLIGENCE_API_KEY;
    delete process.env.INTELLIGENCE_BACKEND;
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    assert.equal(readConfig().intelligenceBackend, "local");
    process.env.INTELLIGENCE_BACKEND = "invalid";
    assert.throws(() => readConfig(), /INTELLIGENCE_BACKEND/);
    process.env.INTELLIGENCE_BACKEND = "copilotkit";
    assert.throws(() => readConfig(), /CPK_INTELLIGENCE_API_KEY/);
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    assert.equal(readConfig().intelligenceApiKey, "test-project-key-never-sent");
    delete process.env.INTELLIGENCE_BACKEND;
    delete process.env.CPK_INTELLIGENCE_API_KEY;
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("auth mode is supabase by default and only accepts the two known modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = { AUTH_MODE: process.env.AUTH_MODE, SUPABASE_URL: process.env.SUPABASE_URL };
  try {
    delete process.env.AUTH_MODE;
    delete process.env.SUPABASE_URL;
    assert.equal(readConfig().authMode, "supabase");
    assert.equal(readConfig().supabaseUrl, defaultSupabaseUrl);
    process.env.AUTH_MODE = "local";
    assert.equal(readConfig().authMode, "local");
    process.env.AUTH_MODE = "off";
    assert.throws(() => readConfig(), /AUTH_MODE/);
    process.env.AUTH_MODE = "local";
    process.env.SUPABASE_URL = "https://self-hosted.example/";
    assert.equal(readConfig().supabaseUrl, "https://self-hosted.example");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("per-user task concurrency defaults to 3 and rejects values that would starve the queue", async () => {
  assert.equal(maxConcurrentPerUser(""), 3);
  assert.equal(maxConcurrentPerUser(" \t\n"), 3);
  assert.equal(maxConcurrentPerUser("1"), 1);
  assert.equal(maxConcurrentPerUser(" 8 "), 8);
  for (const value of ["0", "-1", "1.5", "many"])
    assert.throws(() => maxConcurrentPerUser(value), {
      name: "Error",
      message: "TASK_MAX_CONCURRENT_PER_USER must be a positive integer",
    });
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = process.env.TASK_MAX_CONCURRENT_PER_USER;
  try {
    delete process.env.TASK_MAX_CONCURRENT_PER_USER;
    assert.equal(readConfig().taskMaxConcurrentPerUser, 3);
    process.env.TASK_MAX_CONCURRENT_PER_USER = "5";
    assert.equal(readConfig().taskMaxConcurrentPerUser, 5);
    process.env.TASK_MAX_CONCURRENT_PER_USER = "0";
    assert.throws(() => readConfig(), /TASK_MAX_CONCURRENT_PER_USER/);
  } finally {
    if (old === undefined) delete process.env.TASK_MAX_CONCURRENT_PER_USER;
    else process.env.TASK_MAX_CONCURRENT_PER_USER = old;
  }
});

test("browser worker URL keeps an existing scheme and adds http to host:port", () => {
  assert.equal(browserWorkerUrl(undefined), undefined);
  assert.equal(browserWorkerUrl("  "), undefined);
  assert.equal(browserWorkerUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(browserWorkerUrl("https://browser.internal:8790"), "https://browser.internal:8790");
  assert.equal(browserWorkerUrl("openmuse-browser-h4fx:8790"), "http://openmuse-browser-h4fx:8790");
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("cloud sizing env vars fail loudly instead of mis-provisioning a sandbox", () => {
  for (const value of ["0", "-1", "4.5", "large"]) {
    assert.throws(() => positiveInt("CLOUD_CPU", value, 4), /must be a positive integer/);
  }
  assert.equal(positiveInt("CLOUD_CPU", undefined, 4), 4);
  assert.equal(positiveInt("CLOUD_CPU", " 8 ", 4), 8);
});

test("cloud computer config needs a Daytona key only when the tier is enabled", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const keys = [
    "CLOUD_ENABLED",
    "DAYTONA_API_KEY",
    "DAYTONA_API_URL",
    "CLOUD_CPU",
    "CLOUD_IMAGE_VERSION",
    "CLOUD_DOCKERFILE",
  ] as const;
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(readConfig().cloudEnabled, false);
    assert.equal(readConfig().cloudCpu, 4);
    // v3 is the image with playwright-core in a persistent path; the name suffix
    // is what retires the snapshots earlier images produced.
    assert.equal(readConfig().cloudImageVersion, 3);
    assert.equal(readConfig().cloudDockerfile, undefined);
    process.env.CLOUD_ENABLED = "true";
    assert.throws(() => readConfig(), /DAYTONA_API_KEY/);
    process.env.DAYTONA_API_KEY = "daytona-key";
    process.env.DAYTONA_API_URL = "https://eu.daytona.io/api/";
    process.env.CLOUD_CPU = "2";
    process.env.CLOUD_IMAGE_VERSION = "3";
    process.env.CLOUD_DOCKERFILE = "FROM busybox\n";
    const config = readConfig();
    assert.equal(config.cloudEnabled, true);
    assert.equal(config.daytonaApiUrl, "https://eu.daytona.io/api");
    assert.equal(config.cloudCpu, 2);
    assert.equal(config.cloudImageVersion, 3);
    assert.equal(config.cloudDockerfile, "FROM busybox");
    process.env.CLOUD_CPU = "many";
    assert.throws(() => readConfig(), /CLOUD_CPU/);
    delete process.env.CLOUD_CPU;
    process.env.CLOUD_IMAGE_VERSION = "0";
    assert.throws(() => readConfig(), /CLOUD_IMAGE_VERSION/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
