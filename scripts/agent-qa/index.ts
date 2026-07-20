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
      clientContext: Record<string, unknown>;
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
type DiffInfo = {
  diff: string;
  diffAvailable: boolean;
  diffTruncated: boolean;
};
type RunnerConfig = {
  key: "toolBased" | "naive";
  label: string;
  dir: string;
  host: string;
  binPath: string;
  artifactsDir: string;
  sectionPath: string;
  statusPath: string;
  reportPath: string;
  capturesScreenshots: boolean;
};
type RunFlavorOptions = {
  message: string;
  buildClientContext: () => Record<string, unknown>;
  bootstrapError?: string;
  soft: boolean;
};

const ROOT_DIR = process.cwd();
const ARTIFACTS_DIR = path.join(ROOT_DIR, "artifacts", "qa");
const SCREENSHOTS_DIR = path.join(tmpdir(), "agent-qa-screenshots");
const EVE_PORT = Number(process.env.AGENT_QA_EVE_PORT || 4317);
const NAIVE_EVE_PORT = Number(
  process.env.AGENT_QA_EVE_NAIVE_PORT || EVE_PORT + 1,
);
const SERVER_READY_TIMEOUT_MS = Number(
  process.env.AGENT_QA_EVE_READY_TIMEOUT_MS || 60_000,
);
const MODEL_ID = process.env.QA_MODEL || "openai/gpt-5.4-mini";
const BOOTSTRAP_ERROR = process.env.AGENT_QA_BOOTSTRAP_ERROR;
const DIFF_MAX_CHARS = 20_000;
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

function makeRunnerConfig(options: {
  key: RunnerConfig["key"];
  label: string;
  dir: string;
  port: number;
  capturesScreenshots: boolean;
}): RunnerConfig {
  const artifactsDir = path.join(ARTIFACTS_DIR, options.key);
  return {
    key: options.key,
    label: options.label,
    dir: options.dir,
    host: `http://127.0.0.1:${options.port}`,
    binPath: path.join(options.dir, "node_modules", "eve", "bin", "eve.js"),
    artifactsDir,
    sectionPath: path.join(artifactsDir, "section.md"),
    statusPath: path.join(artifactsDir, "status.txt"),
    reportPath: path.join(artifactsDir, "report.json"),
    capturesScreenshots: options.capturesScreenshots,
  };
}

const TOOL_BASED_CONFIG = makeRunnerConfig({
  key: "toolBased",
  label: "Tool-based agent (agent-device)",
  dir: path.join(ROOT_DIR, "scripts", "agent-qa", "eve"),
  port: EVE_PORT,
  capturesScreenshots: true,
});

const NAIVE_CONFIG = makeRunnerConfig({
  key: "naive",
  label: "Naive prompt-only agent (diff only, no device)",
  dir: path.join(ROOT_DIR, "scripts", "agent-qa", "eve-naive"),
  port: NAIVE_EVE_PORT,
  capturesScreenshots: false,
});

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

function buildToolBasedClientContext(): Record<string, unknown> {
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

function buildNaiveClientContext(diffInfo: DiffInfo): Record<string, unknown> {
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
    platform: context.platform,
    platformLabel: context.platformLabel,
    diff: diffInfo.diff,
    diffAvailable: diffInfo.diffAvailable,
    diffTruncated: diffInfo.diffTruncated,
  };
}

async function loadDiffInfo(): Promise<DiffInfo> {
  const diffPathEnv = process.env.PR_DIFF_PATH;
  if (!diffPathEnv) {
    return { diff: "", diffAvailable: false, diffTruncated: false };
  }

  const diffPath = path.isAbsolute(diffPathEnv)
    ? diffPathEnv
    : path.join(ROOT_DIR, diffPathEnv);

  try {
    const raw = (await readFile(diffPath, "utf8")).trim();
    if (!raw) {
      return { diff: "", diffAvailable: false, diffTruncated: false };
    }

    const truncated = raw.length > DIFF_MAX_CHARS;
    return {
      diff: truncated
        ? `${raw.slice(0, DIFF_MAX_CHARS)}\n...<diff truncated>`
        : raw,
      diffAvailable: true,
      diffTruncated: truncated,
    };
  } catch {
    return { diff: "", diffAvailable: false, diffTruncated: false };
  }
}

async function ensureOutputDirs(): Promise<void> {
  await Promise.all([
    mkdir(TOOL_BASED_CONFIG.artifactsDir, { recursive: true }),
    mkdir(NAIVE_CONFIG.artifactsDir, { recursive: true }),
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

async function writeQaReport(
  config: RunnerConfig,
  input: QaReportInput,
): Promise<void> {
  await ensureOutputDirs();

  const labelMap = new Map(
    (input.screenshotLabels || []).map((item) => [
      item.fileName,
      item.label.trim(),
    ]),
  );
  const screenshots = config.capturesScreenshots
    ? (await uploadScreenshots(await listScreenshots())).map((screenshot) => ({
        ...screenshot,
        label:
          labelMap.get(screenshot.fileName) ||
          humanizeScreenshotLabel(screenshot.fileName),
      }))
    : [];
  const report = {
    generatedAt: new Date().toISOString(),
    mode: config.key,
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
    `### ${context.platformLabel} — ${config.label}`,
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

  await writeFile(
    config.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(config.sectionPath, trim(lines.join("\n"), 16000), "utf8");
  await writeFile(config.statusPath, `${input.overallStatus}\n`, "utf8");
}

function buildServerEnv(config: RunnerConfig): NodeJS.ProcessEnv {
  const rootBin = path.join(ROOT_DIR, "node_modules", ".bin");
  const eveBin = path.join(config.dir, "node_modules", ".bin");

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
  options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
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
  options: { cwd: string; env: NodeJS.ProcessEnv },
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

function ensureEveDependencies(config: RunnerConfig): void {
  if (existsSync(config.binPath)) {
    return;
  }

  const relativeDir = path.relative(ROOT_DIR, config.dir);
  throw new Error(
    `Missing Eve agent dependencies for ${config.label}. Run \`npm ci --prefix ${relativeDir}\` before agent QA.`,
  );
}

async function buildEveApplication(config: RunnerConfig): Promise<void> {
  await runProcess(
    `eve build (${config.key})`,
    process.execPath,
    [config.binPath, "build"],
    { cwd: config.dir, env: buildServerEnv(config) },
  );
}

function startEveServer(config: RunnerConfig): ChildProcess {
  const host = new URL(config.host);
  return spawnLogged(
    process.execPath,
    [
      config.binPath,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      host.port,
    ],
    {
      cwd: config.dir,
      env: buildServerEnv(config),
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
    `Timed out waiting ${SERVER_READY_TIMEOUT_MS}ms for Eve server at ${child.spawnargs.join(" ")}.`,
  );
}

async function loadEveClient(config: RunnerConfig): Promise<EveClientModule> {
  const requireFromEve = createRequire(path.join(config.dir, "package.json"));
  return import(
    pathToFileURL(requireFromEve.resolve("eve/client")).href
  ) as Promise<EveClientModule>;
}

async function runEveQa(
  client: EveClient,
  message: string,
  clientContext: Record<string, unknown>,
) {
  const session = client.session();
  const response = await session.send<QaReportInput>({
    message,
    clientContext,
    outputSchema: QA_REPORT_OUTPUT_SCHEMA,
  });
  const result = await response.result();

  return {
    status: result.status,
    message: result.message,
    data: result.data,
  };
}

async function runFlavorUnsafe(
  config: RunnerConfig,
  options: RunFlavorOptions,
): Promise<void> {
  ensureEveDependencies(config);
  await buildEveApplication(config);

  const { Client } = await loadEveClient(config);
  const client = new Client({
    host: config.host,
    maxReconnectAttempts: 5,
  });
  const server = startEveServer(config);

  try {
    await waitForEveServer(server, client);
    const result = await runEveQa(
      client,
      options.message,
      options.buildClientContext(),
    );

    if (result.message) {
      console.log(
        trim(
          `Eve agent (${config.key}) finished with final text:\n${result.message}`,
          4000,
        ),
      );
    }

    if (!result.data) {
      await writeBlockedReport(
        config,
        new Error(
          result.message ||
            `The Eve agent completed with status "${result.status}" without structured QA report data.`,
        ),
      );
      console.log(
        `Fallback QA report written to ${config.sectionPath} because structured QA report data was not returned.`,
      );
      return;
    }

    await writeQaReport(config, result.data);
    console.log(`QA report written to ${config.sectionPath}`);
  } finally {
    await stopEveServer(server);
  }
}

async function writeBlockedReport(
  config: RunnerConfig,
  error: Error,
): Promise<void> {
  await writeQaReport(config, {
    overallStatus: "blocked",
    summary: error.message,
    checked: [`Attempted to run ${context.platformLabel} ${config.label}`],
    issues: [error.message],
    nextSteps:
      config.key === "toolBased"
        ? [
            "Check the workflow logs for command failures.",
            `Verify AI Gateway credentials, ${context.platformLabel} build availability, and ${context.platform === "ios" ? "simulator" : "emulator"} configuration.`,
          ]
        : [
            "Check the workflow logs for command failures.",
            "Verify AI Gateway credentials and that a PR diff was available at PR_DIFF_PATH.",
          ],
  });
}

async function runFlavor(
  config: RunnerConfig,
  options: RunFlavorOptions,
): Promise<void> {
  if (options.bootstrapError) {
    await writeBlockedReport(config, new Error(options.bootstrapError));
    return;
  }

  if (!options.soft) {
    await runFlavorUnsafe(config, options);
    return;
  }

  try {
    await runFlavorUnsafe(config, options);
  } catch (unknownError) {
    const error =
      unknownError instanceof Error
        ? unknownError
        : new Error(String(unknownError));
    console.error(error);
    await writeBlockedReport(config, error);
  }
}

async function main(): Promise<void> {
  await ensureOutputDirs();
  ensureRequiredAgentQaEnvs();

  const diffInfo = await loadDiffInfo();

  const naivePromise = runFlavor(NAIVE_CONFIG, {
    message:
      "Review the pull request diff in clientContext and decide whether this change looks correct for the requested platform.",
    buildClientContext: () => buildNaiveClientContext(diffInfo),
    soft: true,
  });

  try {
    await runFlavor(TOOL_BASED_CONFIG, {
      message:
        "Run the mobile QA pass for the pull request described in clientContext.",
      buildClientContext: buildToolBasedClientContext,
      bootstrapError: BOOTSTRAP_ERROR || undefined,
      soft: false,
    });
  } finally {
    await naivePromise;
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
  await writeBlockedReport(TOOL_BASED_CONFIG, error);
  process.exitCode = 1;
}
