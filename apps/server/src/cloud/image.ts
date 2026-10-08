import { cloudDefaults } from "../config.ts";

/**
 * The cloud sandbox image, built into the org snapshot the tier creates sandboxes from.
 *
 * Probe-verified on hosted Daytona: `POST /api/snapshots` takes
 * `{name, imageName|buildInfo, cpu, memory, disk}` and `buildInfo.dockerfileContent`
 * builds the image from a Dockerfile, which is how a browser gets baked in. Sandboxes
 * themselves reject per-sandbox resources, so the size lives in the snapshot. The base
 * must stay a `daytonaio/sandbox` image: it carries the toolbox that exec and file
 * access run through, and a raw OS image has nothing to execute against.
 */

/** The persistent Chromium profile, kept inside the sandbox home so it survives a stop. */
export const omBrowserProfile = "/home/daytona/.om-browser";

/** Where the CLI lands in the image: on PATH for every `cloud_exec` shell. */
export const omBrowserPath = "/usr/local/bin/om-browser";

/**
 * Chromium's own binaries are downloaded at build time, when HOME is root's, and read at
 * runtime, when the toolbox executes as `daytona`. Pinning the shared path keeps the two
 * apart: the default cache would land in /root and be invisible to the sandbox user.
 */
const browsersPath = "/ms-playwright";

/**
 * The in-sandbox browser CLI. One persistent profile per sandbox, one JSON line on stdout,
 * and failures on stderr with a non-zero exit — so `cloud_exec` reports them like any other
 * command. Flush-left on purpose: the text below is the file's exact content.
 */
export function omBrowserScript(): string {
  return `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PROFILE = "${omBrowserProfile}";
const NAVIGATION_TIMEOUT_MS = 60000;
const EVAL_SETTLE_MS = 500;
const FLAGS = { "--html": "html", "--screenshot": "screenshot", "--pdf": "pdf" };

function fail(message) {
  console.error("om-browser: " + message);
  process.exit(1);
}

// playwright-core lives in an explicit image path: hosted Daytona's build
// environment offers an npm whose global prefix is ephemeral — a global install
// succeeds and downloads the browsers, yet the module itself never lands in
// the image (probe-verified: chromium present in /ms-playwright, module gone).
// A local install under /opt is ordinary image content and survives.
function loadChromium() {
  const candidates = ["/opt/om-browser/node_modules/playwright-core", "playwright-core"];
  for (const root of (process.env.NODE_PATH || "").split(":"))
    if (root) candidates.push(path.join(root, "playwright-core"));
  candidates.push("/usr/local/lib/node_modules/playwright-core");
  candidates.push("/usr/lib/node_modules/playwright-core");
  for (const candidate of candidates) {
    try {
      const chromium = require(candidate).chromium;
      if (chromium) return chromium;
    } catch (error) {
      if (error && error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  return fail("playwright-core is missing from the sandbox image");
}

function parseOptions(argv) {
  const options = { wait: 0, html: null, screenshot: null, pdf: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--wait" && !Object.hasOwn(FLAGS, arg)) {
      positional.push(arg);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) fail(arg + " needs a value");
    index += 1;
    if (arg === "--wait") options.wait = Number(value);
    else options[FLAGS[arg]] = value;
  }
  if (!Number.isFinite(options.wait) || options.wait < 0) fail("--wait needs a millisecond count");
  return { options, positional };
}

async function navigate(chromium, url, settleMs) {
  const context = await chromium.launchPersistentContext(PROFILE, { headless: true });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function open(argv) {
  const { options, positional } = parseOptions(argv);
  const url = positional[0];
  if (!url)
    fail("usage: om-browser open <url> [--wait ms] [--html path] [--screenshot path] [--pdf path]");
  const { context, page } = await navigate(loadChromium(), url, options.wait);
  try {
    if (options.html) fs.writeFileSync(options.html, await page.content());
    if (options.screenshot) await page.screenshot({ path: options.screenshot });
    if (options.pdf) await page.pdf({ path: options.pdf });
    return {
      title: await page.title(),
      url: page.url(),
      htmlPath: options.html,
      screenshotPath: options.screenshot,
      pdfPath: options.pdf,
    };
  } finally {
    await context.close();
  }
}

async function evaluate(argv) {
  const url = argv[0];
  const expression = argv[1];
  if (!url || !expression) fail("usage: om-browser eval <url> <javascript-expression>");
  const { context, page } = await navigate(loadChromium(), url, EVAL_SETTLE_MS);
  try {
    return await page.evaluate(expression);
  } finally {
    await context.close();
  }
}

async function main() {
  const command = process.argv[2];
  const argv = process.argv.slice(3);
  if (command === "open") return open(argv);
  if (command === "eval") return evaluate(argv);
  return fail('usage: om-browser <open|eval> ... (got "' + (command || "") + '")');
}

main()
  .then((result) => {
    const serialized = JSON.stringify(result);
    console.log(serialized === undefined ? "null" : serialized);
  })
  .catch((error) => fail(error && error.message ? error.message : String(error)));
`;
}

/** Shell single-quoting, so a line of the script survives `printf` verbatim. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The Dockerfile the snapshot is built from. The base declares `USER daytona`
 * (registry-verified on daytonaio/sandbox:0.8.0), so the build steps first switch
 * to root — apt and npm -g both refuse to run otherwise — and the end switches
 * back, because the toolbox contract expects the sandbox to run as `daytona`.
 */
export function cloudDockerfile(baseImage: string = cloudDefaults.baseImage): string {
  const script = omBrowserScript()
    .trimEnd()
    .split("\n")
    .map((line) => `  ${shellQuote(line)} \\`)
    .join("\n");
  return `FROM ${baseImage}

USER root

# The toolbox runs commands under a closed PATH/HOME/LANG env, so image env may not reach
# them; both are set here and re-derived inside om-browser as a fallback.
ENV PLAYWRIGHT_BROWSERS_PATH=${browsersPath}
ENV NODE_PATH=/usr/local/lib/node_modules

# Without a CJK font, Chinese and Japanese pages render as blank boxes in screenshots and PDFs.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates \\
 && rm -rf /var/lib/apt/lists/*

# playwright-core ships the same \`install\` CLI as the full package. It is installed
# into an explicit image path rather than globally: the build-time npm's global
# prefix does not survive into the snapshot, a local node_modules does. The browser
# is downloaded into PLAYWRIGHT_BROWSERS_PATH and its system libraries come from --with-deps.
RUN mkdir -p /opt/om-browser \\
 && cd /opt/om-browser \\
 && npm init -y \\
 && npm install playwright-core \\
 && node node_modules/playwright-core/cli.js install --with-deps chromium \\
 && rm -rf /var/lib/apt/lists/*

# The persistent profile must belong to the user the toolbox executes as, or Chromium
# cannot write it.
RUN mkdir -p ${omBrowserProfile} \\
 && chown -R daytona ${omBrowserProfile}

# The browser CLI, written line by line because the build input is a Dockerfile and not a
# build context: there is no second file to COPY from.
RUN printf '%s\\n' \\
${script}
  > ${omBrowserPath} \\
 && chmod +x ${omBrowserPath}

# Back to the base image's user: the toolbox and the sandbox runtime expect daytona.
USER daytona
`;
}
