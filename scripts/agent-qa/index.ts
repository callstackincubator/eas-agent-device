import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

type EveClientModule = {
  Client: new (options: {
    host: string;
    maxReconnectAttempts?: number;
  }) => {
    session(): {
      send(input: {
        message: string;
        clientContext: ReturnType<typeof buildClientContext>;
      }): Promise<{
        result(): Promise<{ status: string; message?: string }>;
      }>;
    };
  };
};
type QaPlatform = "android" | "ios";
type ParsedPr = {
  number?: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  labels?: Array<{ name?: string }>;
};

const ROOT_DIR = process.cwd();
const EVE_DIR = path.join(ROOT_DIR, "scripts", "agent-qa", "eve");
const ARTIFACTS_DIR = path.join(ROOT_DIR, "artifacts", "qa");
const SCREENSHOTS_DIR = path.join(tmpdir(), "agent-qa-screenshots");
const SECTION_PATH = path.join(ARTIFACTS_DIR, "section.md");
const STATUS_PATH = path.join(ARTIFACTS_DIR, "status.txt");
const REPORT_PATH = path.join(ARTIFACTS_DIR, "report.json");
const EVE_PORT = Number(process.env.AGENT_QA_EVE_PORT || 4317);
const EVE_HOST = `http://127.0.0.1:${EVE_PORT}`;
const SERVER_READY_TIMEOUT_MS = Number(
  process.env.AGENT_QA_EVE_READY_TIMEOUT_MS || 60_000,
);
const EVE_PACKAGE_PATH = path.join(
  EVE_DIR,
  "node_modules",
  "eve",
  "package.json",
);
const EVE_BIN_PATH = path.join(EVE_DIR, "node_modules", "eve", "bin", "eve.js");
const requireFromEve = createRequire(path.join(EVE_DIR, "package.json"));
const MODEL_ID = process.env.QA_MODEL || "openai/gpt-5.4-mini";
const BOOTSTRAP_ERROR = process.env.AGENT_QA_BOOTSTRAP_ERROR;
const pr = parseJson<ParsedPr>(process.env.PR_JSON, {});
const platform = normalizePlatform(process.env.QA_PLATFORM);
const context = {
  platform,
  platformLabel: platform === "ios" ? "iOS" : "Android",
  buildId: process.env.BUILD_ID || "",
  buildPath: process.env.APP_PATH || "",
  prNumber: Number(pr.number || 0),
  workflowUrl: process.env.WORKFLOW_URL || "",
  applicationId: process.env.APPLICATION_ID || "",
  deviceName:
    process.env.DEVICE_NAME ||
    (platform === "ios"
      ? process.env.AGENT_DEVICE_IOS_DEVICE || ""
      : process.env.AGENT_DEVICE_ANDROID_DEVICE || ""),
};

function normalizePlatform(value: string | undefined): QaPlatform {
  return value === "ios" ? "ios" : "android";
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function trim(value: string, max = 6000): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}\n...<truncated>`;
}

function buildClientContext() {
  return {
    prNumber: context.prNumber,
    title: pr.title || "Untitled PR",
    body: pr.body || "No PR body was provided.",
    labels: Array.isArray(pr.labels)
      ? pr.labels
          .map((label) => label.name)
          .filter((name): name is string => Boolean(name))
      : [],
    draft: Boolean(pr.draft),
    buildId: context.buildId,
    buildPath: context.buildPath,
    workflowUrl: context.workflowUrl,
    platform: context.platform,
    platformLabel: context.platformLabel,
    applicationId: context.applicationId,
    deviceName: context.deviceName,
    screenshotsDir: SCREENSHOTS_DIR,
  };
}

async function ensureOutputDirs(): Promise<void> {
  await Promise.all([
    mkdir(ARTIFACTS_DIR, { recursive: true }),
    mkdir(SCREENSHOTS_DIR, { recursive: true }),
  ]);
}

function ensureRequiredAgentQaEnvs(): void {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      "Missing required AI Gateway credentials: set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN",
    );
  }
  if (!context.buildPath) {
    throw new Error("Missing required environment variable: APP_PATH");
  }
  if (!context.applicationId) {
    throw new Error("Missing required environment variable: APPLICATION_ID");
  }
  if (context.platform === "ios" && !context.deviceName) {
    throw new Error(
      "Missing required environment variable: AGENT_DEVICE_IOS_DEVICE",
    );
  }
}

async function writeBlockedReport(error: Error): Promise<void> {
  await ensureOutputDirs();

  const report = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    buildId: context.buildId,
    workflowUrl: context.workflowUrl,
    platform: context.platform,
    platformLabel: context.platformLabel,
    prNumber: context.prNumber,
    screenshots: [],
    overallStatus: "blocked",
    summary: error.message,
    checked: [`Attempted to run ${context.platformLabel} QA agent on PR changes`],
    issues: [error.message],
    nextSteps: [
      "Check the workflow logs for command failures.",
      `Verify AI Gateway credentials, ${context.platformLabel} build availability, and ${context.platform === "ios" ? "simulator" : "emulator"} configuration.`,
    ],
  };

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(STATUS_PATH, "blocked\n", "utf8");
  await writeFile(
    SECTION_PATH,
    [
      `### ${context.platformLabel}`,
      "",
      "**Status:** blocked",
      "",
      error.message,
      "",
      "### Checked",
      ...report.checked.map((item) => `- ${item}`),
      "",
      "### Issues",
      `- ${error.message}`,
      "",
      "### Screenshots",
      "- No screenshots were saved.",
      "",
      "### Next steps",
      ...report.nextSteps.map((step) => `- ${step}`),
      "",
    ].join("\n"),
    "utf8",
  );
}

function buildServerEnv(): NodeJS.ProcessEnv {
  const rootBin = path.join(ROOT_DIR, "node_modules", ".bin");
  const eveBin = path.join(EVE_DIR, "node_modules", ".bin");

  return {
    ...process.env,
    AGENT_QA_ROOT_DIR: ROOT_DIR,
    AGENT_QA_SCREENSHOTS_DIR: SCREENSHOTS_DIR,
    PATH: [rootBin, eveBin, process.env.PATH || ""].filter(Boolean).join(":"),
  };
}

function spawnLogged(
  command: string,
  args: string[],
  options: { cwd: string; detached?: boolean },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: options.detached,
    env: buildServerEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  return child;
}

async function runProcess(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnLogged(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${label} failed (code ${code ?? "n/a"}, signal ${signal ?? "n/a"}).`,
        ),
      );
    });
  });
}

function ensureEveDependencies(): void {
  if (existsSync(EVE_PACKAGE_PATH) && existsSync(EVE_BIN_PATH)) {
    return;
  }

  throw new Error(
    "Missing Eve agent dependencies. Run `npm ci --prefix scripts/agent-qa/eve` before agent QA.",
  );
}

async function buildEveApplication(): Promise<void> {
  await runProcess("eve build", process.execPath, [EVE_BIN_PATH, "build"], {
    cwd: EVE_DIR,
  });
}

function startEveServer(): ChildProcess {
  return spawnLogged(
    process.execPath,
    [
      EVE_BIN_PATH,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(EVE_PORT),
    ],
    {
      cwd: EVE_DIR,
      detached: process.platform !== "win32",
    },
  );
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child below.
    }
  }

  child.kill(signal);
}

async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<"exit" | "timeout"> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return "exit";
  }

  return Promise.race([
    new Promise<"exit">((resolve) => {
      child.once("exit", () => resolve("exit"));
    }),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
}

async function stopEveServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalProcessTree(child, "SIGTERM");

  if ((await waitForProcessExit(child, 5_000)) === "timeout") {
    signalProcessTree(child, "SIGKILL");
    await waitForProcessExit(child, 2_000);
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitForEveServer(child: ChildProcess) {
  const startedAt = Date.now();
  let exitError: Error | undefined;

  child.once("exit", (code, signal) => {
    exitError = new Error(
      `Eve server exited before becoming ready (code ${code ?? "n/a"}, signal ${signal ?? "n/a"}).`,
    );
  });

  while (Date.now() - startedAt < SERVER_READY_TIMEOUT_MS) {
    if (exitError) {
      throw exitError;
    }

    try {
      const response = await fetch(`${EVE_HOST}/eve/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Timed out waiting ${SERVER_READY_TIMEOUT_MS}ms for Eve server at ${EVE_HOST}.`,
  );
}

async function loadEveClient(): Promise<EveClientModule> {
  return import(
    pathToFileURL(requireFromEve.resolve("eve/client")).href
  ) as Promise<EveClientModule>;
}

async function runEveQa() {
  const { Client } = await loadEveClient();
  const client = new Client({
    host: EVE_HOST,
    maxReconnectAttempts: 5,
  });
  const session = client.session();
  const response = await session.send({
    message: "Run the mobile QA pass for the pull request described in clientContext.",
    clientContext: buildClientContext(),
  });
  const result = await response.result();

  return {
    status: result.status,
    message: result.message,
  };
}

async function main(): Promise<void> {
  await ensureOutputDirs();
  ensureRequiredAgentQaEnvs();

  if (BOOTSTRAP_ERROR) {
    await writeBlockedReport(new Error(BOOTSTRAP_ERROR));
    return;
  }

  ensureEveDependencies();
  await buildEveApplication();

  const server = startEveServer();

  try {
    await waitForEveServer(server);
    const result = await runEveQa();

    if (result.message) {
      console.log(
        trim(`Eve agent finished with final text:\n${result.message}`, 4000),
      );
    }

    if (!existsSync(SECTION_PATH)) {
      await writeBlockedReport(
        new Error(
          result.message ||
            `The Eve agent completed with status "${result.status}" without calling write_report.`,
        ),
      );
      console.log(
        `Fallback QA report written to ${SECTION_PATH} because write_report was not called.`,
      );
      return;
    }

    console.log(`QA report written to ${SECTION_PATH}`);
  } finally {
    await stopEveServer(server);
  }
}

try {
  await main();
} catch (unknownError) {
  const error =
    unknownError instanceof Error
      ? unknownError
      : new Error(String(unknownError));
  console.error(error);
  await writeBlockedReport(error);
  process.exitCode = 1;
}
