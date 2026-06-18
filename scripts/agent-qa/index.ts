import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { put } from "@vercel/blob";

type QaStatus = "passed" | "failed" | "blocked" | "not_tested" | "unsure";
type QaReportInput = {
  overallStatus: QaStatus;
  summary: string;
  checked?: string[];
  issues?: string[];
  nextSteps?: string[];
  screenshotLabels?: Array<{
    fileName: string;
    label: string;
  }>;
};
type ScreenshotInfo = {
  fileName: string;
  absolutePath: string;
  bytes: number;
  label?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  blobPathname?: string;
  uploadError?: string;
};
type EveClient = {
  health(): Promise<unknown>;
  session(): {
    send<T>(input: {
      message: string;
      clientContext: ReturnType<typeof buildClientContext>;
      outputSchema?: unknown;
    }): Promise<{
      result(): Promise<{ status: string; message?: string; data?: T }>;
    }>;
  };
};
type EveClientModule = {
  Client: new (options: {
    host: string;
    maxReconnectAttempts?: number;
  }) => EveClient;
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
const QA_REPORT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overallStatus: {
      type: "string",
      enum: ["passed", "failed", "blocked", "not_tested", "unsure"],
    },
    summary: { type: "string" },
    checked: {
      type: "array",
      items: { type: "string" },
    },
    issues: {
      type: "array",
      items: { type: "string" },
    },
    nextSteps: {
      type: "array",
      items: { type: "string" },
    },
    screenshotLabels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fileName: {
            type: "string",
            description: "Saved screenshot file name, including .png.",
          },
          label: {
            type: "string",
            description: "Very short route or state label.",
          },
        },
        required: ["fileName", "label"],
      },
    },
  },
  required: ["overallStatus", "summary"],
} as const;
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

function humanizeScreenshotLabel(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const words = stem
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ") || fileName;
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

async function listScreenshots(): Promise<ScreenshotInfo[]> {
  if (!existsSync(SCREENSHOTS_DIR)) {
    return [];
  }

  const entries = await readdir(SCREENSHOTS_DIR);
  const screenshots: ScreenshotInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".png")) {
      continue;
    }

    const absolutePath = path.join(SCREENSHOTS_DIR, entry);
    const fileStat = await stat(absolutePath);
    screenshots.push({
      fileName: entry,
      absolutePath,
      bytes: fileStat.size,
    });
  }

  return screenshots.sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
}

async function uploadScreenshots(
  screenshots: ScreenshotInfo[],
): Promise<ScreenshotInfo[]> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || screenshots.length === 0) {
    return screenshots;
  }

  return Promise.all(
    screenshots.map(async (screenshot) => {
      try {
        const blob = await put(
          [
            "agent-qa",
            context.platform,
            context.prNumber ? `pr-${context.prNumber}` : "pr-unknown",
            context.buildId || "local-build",
            screenshot.fileName,
          ].join("/"),
          await readFile(screenshot.absolutePath),
          {
            access: "public",
            addRandomSuffix: true,
            contentType: "image/png",
            token,
          },
        );

        return {
          ...screenshot,
          blobUrl: blob.url,
          blobDownloadUrl: blob.downloadUrl,
          blobPathname: blob.pathname,
        };
      } catch (unknownError) {
        const error =
          unknownError instanceof Error
            ? unknownError
            : new Error(String(unknownError));
        return { ...screenshot, uploadError: error.message };
      }
    }),
  );
}

function renderScreenshotRows(screenshots: ScreenshotInfo[]): string[] {
  if (screenshots.length === 0) {
    return ["- No screenshots were saved."];
  }

  if (screenshots.some((screenshot) => screenshot.blobUrl)) {
    return [
      "| Screenshot |",
      "| --- |",
      ...screenshots
        .filter((screenshot) => screenshot.blobUrl)
        .map(
          (screenshot) =>
            `| <a href="${screenshot.blobUrl}"><img src="${screenshot.blobUrl}" alt="${screenshot.label || screenshot.fileName}" height="500" /></a> |`,
        ),
    ];
  }

  return screenshots.map(
    (screenshot) =>
      `- ${screenshot.label || screenshot.fileName} (${screenshot.bytes} bytes)`,
  );
}

async function writeQaReport(input: QaReportInput): Promise<void> {
  await ensureOutputDirs();

  const labelMap = new Map(
    (input.screenshotLabels || []).map((item) => [
      item.fileName,
      item.label.trim(),
    ]),
  );
  const screenshots = (await uploadScreenshots(await listScreenshots())).map(
    (screenshot) => ({
      ...screenshot,
      label:
        labelMap.get(screenshot.fileName) ||
        humanizeScreenshotLabel(screenshot.fileName),
    }),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    buildId: context.buildId,
    workflowUrl: context.workflowUrl,
    platform: context.platform,
    platformLabel: context.platformLabel,
    prNumber: context.prNumber,
    screenshots,
    ...input,
  };
  const lines = [
    `### ${context.platformLabel}`,
    "",
    `**Status:** ${input.overallStatus}`,
    "",
    input.summary,
    "",
    "### Checked",
    ...(input.checked?.length
      ? input.checked.map((item) => `- ${item}`)
      : ["- No checks were recorded."]),
    "",
    "### Issues",
    ...(input.issues?.length
      ? input.issues.map((issue) => `- ${issue}`)
      : ["- No issues noted."]),
    "",
    "### Screenshots",
    ...renderScreenshotRows(screenshots),
    "",
    "### Next steps",
    ...(input.nextSteps?.length
      ? input.nextSteps.map((step) => `- ${step}`)
      : ["- No follow-up actions were suggested."]),
    "",
    "### Metadata",
    `- Build ID: \`${report.buildId || "n/a"}\``,
    `- Workflow: ${report.workflowUrl || "n/a"}`,
    "",
  ];

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(SECTION_PATH, trim(lines.join("\n"), 16000), "utf8");
  await writeFile(STATUS_PATH, `${input.overallStatus}\n`, "utf8");
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

async function waitForEveServer(child: ChildProcess, client: EveClient) {
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
      await client.health();
      return;
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

async function runEveQa(client: EveClient) {
  const session = client.session();
  const response = await session.send<QaReportInput>({
    message: "Run the mobile QA pass for the pull request described in clientContext.",
    clientContext: buildClientContext(),
    outputSchema: QA_REPORT_OUTPUT_SCHEMA,
  });
  const result = await response.result();

  return {
    status: result.status,
    message: result.message,
    data: result.data,
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

  const { Client } = await loadEveClient();
  const client = new Client({
    host: EVE_HOST,
    maxReconnectAttempts: 5,
  });
  const server = startEveServer();

  try {
    await waitForEveServer(server, client);
    const result = await runEveQa(client);

    if (result.message) {
      console.log(
        trim(`Eve agent finished with final text:\n${result.message}`, 4000),
      );
    }

    if (!result.data) {
      await writeBlockedReport(
        new Error(
          result.message ||
            `The Eve agent completed with status "${result.status}" without structured QA report data.`,
        ),
      );
      console.log(
        `Fallback QA report written to ${SECTION_PATH} because structured QA report data was not returned.`,
      );
      return;
    }

    await writeQaReport(result.data);
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
