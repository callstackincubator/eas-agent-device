import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { put } from "@vercel/blob";

export type QaPlatform = "android" | "ios";

export type ScreenshotInfo = {
  fileName: string;
  absolutePath: string;
  bytes: number;
  label?: string;
  blobUrl?: string;
  blobDownloadUrl?: string;
  blobPathname?: string;
  uploadError?: string;
};

export type ScreenshotLabel = {
  fileName: string;
  label: string;
};

export type AgentDeviceTraceEntry = {
  requestedCommand: string;
  requestedArgs: string[];
  normalizedCommand: string;
  normalizedArgs: string[];
  executedArgv?: string[];
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ResultStatus = "passed" | "failed" | "blocked" | "not_tested" | "unsure";

export type ReportInput = {
  overallStatus: ResultStatus;
  summary: string;
  checked?: string[];
  issues?: string[];
  nextSteps?: string[];
  screenshotLabels?: ScreenshotLabel[];
};

type Report = ReportInput & {
  generatedAt: string;
  model: string;
  buildId: string;
  workflowUrl: string;
  platform: QaPlatform;
  platformLabel: string;
  prNumber: number;
  screenshots: ScreenshotInfo[];
  agentDeviceTrace: AgentDeviceTraceEntry[];
};

type ParsedPr = {
  number?: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  labels?: Array<{ name?: string }>;
};

type CommandResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ExecFileError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
};

const execFile = promisify(execFileCallback);
const AGENT_DEVICE_BIN = "agent-device";
const UI_CHANGING_AGENT_DEVICE_COMMANDS = new Set([
  "back",
  "click",
  "fill",
  "gesture",
  "longpress",
  "open",
  "press",
  "scroll",
  "swipe",
  "type",
  "wait",
]);

export const ROOT_DIR = path.resolve(
  process.env.AGENT_QA_ROOT_DIR || process.cwd(),
);
const ARTIFACTS_DIR = path.join(ROOT_DIR, "artifacts", "qa");
export const SCREENSHOTS_DIR = path.join(tmpdir(), "agent-qa-screenshots");
const REPORT_PATH = path.join(ARTIFACTS_DIR, "report.json");
export const SECTION_PATH = path.join(ARTIFACTS_DIR, "section.md");
const STATUS_PATH = path.join(ARTIFACTS_DIR, "status.txt");
const MODEL_ID = process.env.QA_MODEL || "openai/gpt-5.4-mini";
export const BOOTSTRAP_ERROR = process.env.AGENT_QA_BOOTSTRAP_ERROR;

const APP_PATH = process.env.APP_PATH;
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const pr = parseJson<ParsedPr>(process.env.PR_JSON, {});

export const context = {
  platform: normalizePlatform(process.env.QA_PLATFORM),
  platformLabel: normalizePlatform(process.env.QA_PLATFORM) === "ios" ? "iOS" : "Android",
  buildId: process.env.BUILD_ID || "",
  buildPath: APP_PATH || "",
  prNumber: Number(pr.number || 0),
  workflowUrl: process.env.WORKFLOW_URL || "",
  applicationId: process.env.APPLICATION_ID || "",
  deviceName:
    process.env.DEVICE_NAME ||
    (process.env.QA_PLATFORM === "ios"
      ? process.env.AGENT_DEVICE_IOS_DEVICE || ""
      : process.env.AGENT_DEVICE_ANDROID_DEVICE || ""),
};

export const agentDeviceTrace: AgentDeviceTraceEntry[] = [];

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

export function trim(value: string, max = 6000): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}\n...<truncated>`;
}

function isNumericTarget(value: string | undefined): boolean {
  return Boolean(value?.trim()) && Number.isFinite(Number(value));
}

function isRefTarget(value: string): boolean {
  return /^@e\d+$/.test(value.trim());
}

function isSelectorTarget(value: string): boolean {
  return /\b(?:id|label|role|value|text|placeholder|name|testID|testId|identifier)=["'][^"']+["']/.test(
    value,
  );
}

function rejectBarePressOrClickTarget(
  command: string,
  args: string[],
): CommandResult | null {
  if (command !== "press" && command !== "click") {
    return null;
  }

  const target = args.join(" ").trim();
  if (
    (isNumericTarget(args[0]) && isNumericTarget(args[1])) ||
    isRefTarget(target) ||
    isSelectorTarget(target)
  ) {
    return null;
  }

  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr:
      "Error (INVALID_ARGS): Bare labels are not valid targets; use @eN from snapshot or label=\"...\".",
  };
}

function rejectInvalidCommandName(command: string): CommandResult | null {
  if (!command.trim()) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr:
        "Error (INVALID_ARGS): Missing agent-device command. Use command for the subcommand and args for flags or arguments.",
    };
  }

  if (!/\s/.test(command.trim())) {
    return null;
  }

  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr:
      'Error (INVALID_ARGS): command must be a single agent-device subcommand. Put flags and arguments in args, for example command "snapshot" with args ["-i"].',
  };
}

function normalizeAgentDeviceArgs(command: string, args: string[]): string[] {
  if (command === "help" && args.length === 0) {
    return ["workflow"];
  }

  return args;
}

function requiresEvidenceScreenshot(status: ResultStatus): boolean {
  return status === "passed" || status === "failed" || status === "unsure";
}

function humanizeScreenshotLabel(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const words = stem
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ") || fileName;
}

async function runCommand(
  file: string,
  args: string[],
): Promise<CommandResult> {
  try {
    const result = await execFile(file, args, {
      cwd: ROOT_DIR,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    return {
      ok: true,
      exitCode: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (unknownError) {
    const error = unknownError as ExecFileError;
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr =
      typeof error.stderr === "string" ? error.stderr : error.message;
    const exitCode = typeof error.code === "number" ? error.code : 1;

    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
    };
  }
}

export async function runAgentDeviceCommand(
  command: string,
  args: string[] = [],
): Promise<{
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json: unknown;
}> {
  const normalizedCommand = command.trim();
  const normalizedArgs = normalizeAgentDeviceArgs(normalizedCommand, args);
  const argv = [normalizedCommand, ...normalizedArgs];
  const preflightResult =
    rejectInvalidCommandName(command) ||
    rejectBarePressOrClickTarget(normalizedCommand, normalizedArgs);
  const result =
    preflightResult || (await runCommand(AGENT_DEVICE_BIN, argv));

  agentDeviceTrace.push({
    requestedCommand: command,
    requestedArgs: args,
    normalizedCommand,
    normalizedArgs,
    ...(preflightResult ? {} : { executedArgv: argv }),
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: trim(result.stdout, 4000),
    stderr: trim(result.stderr, 2000),
  });

  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: trim(result.stdout, 8000),
    stderr: trim(result.stderr, 4000),
    json: parseJson(result.stdout, null as unknown),
  };
}

export async function ensureOutputDirs(): Promise<void> {
  await Promise.all([
    mkdir(ARTIFACTS_DIR, { recursive: true }),
    mkdir(SCREENSHOTS_DIR, { recursive: true }),
  ]);
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

async function uploadScreenshotsToBlob(
  screenshots: ScreenshotInfo[],
): Promise<ScreenshotInfo[]> {
  if (!BLOB_READ_WRITE_TOKEN || screenshots.length === 0) {
    return screenshots;
  }

  return Promise.all(
    screenshots.map(async (screenshot) => {
      try {
        const fileBuffer = await readFile(screenshot.absolutePath);
        const pathnameParts = [
          "agent-qa",
          context.platform,
          context.prNumber ? `pr-${context.prNumber}` : "pr-unknown",
          context.buildId || "local-build",
          screenshot.fileName,
        ];
        const pathname = pathnameParts.join("/");
        const blob = await put(pathname, fileBuffer, {
          access: "public",
          addRandomSuffix: true,
          contentType: "image/png",
          token: BLOB_READ_WRITE_TOKEN,
        });

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

        console.error(
          `Failed to upload screenshot ${screenshot.fileName} to Vercel Blob: ${error.message}`,
        );

        return {
          ...screenshot,
          uploadError: error.message,
        };
      }
    }),
  );
}

export async function writeBlockedReport(error: Error): Promise<void> {
  const summary: ReportInput = {
    overallStatus: "blocked",
    summary: error.message,
    checked: [
      `Attempted to run ${context.platformLabel} QA agent on PR changes`,
    ],
    issues: [error.message],
    nextSteps: [
      "Check the workflow logs for command failures.",
      `Verify AI Gateway credentials, ${context.platformLabel} build availability, and ${context.platform === "ios" ? "simulator" : "emulator"} configuration.`,
    ],
  };

  await persistReport(summary);
}

async function persistReport(reportInput: ReportInput) {
  await ensureOutputDirs();
  const screenshotLabelMap = new Map(
    (reportInput.screenshotLabels || [])
      .filter(
        (item): item is ScreenshotLabel =>
          Boolean(item?.fileName) && Boolean(item?.label),
      )
      .map((item) => [item.fileName, item.label.trim()]),
  );
  const screenshots = (
    await uploadScreenshotsToBlob(await listScreenshots())
  ).map((screenshot) => ({
    ...screenshot,
    label:
      screenshotLabelMap.get(screenshot.fileName) ||
      humanizeScreenshotLabel(screenshot.fileName),
  }));
  const report: Report = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    buildId: context.buildId,
    workflowUrl: context.workflowUrl,
    platform: context.platform,
    platformLabel: context.platformLabel,
    prNumber: context.prNumber,
    screenshots,
    agentDeviceTrace: agentDeviceTrace.slice(-20),
    ...reportInput,
  };

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(SECTION_PATH, trim(renderPlatformSection(report), 16000), "utf8");
  await writeFile(STATUS_PATH, `${report.overallStatus}\n`, "utf8");
}

function renderScreenshotRows(
  screenshots: ScreenshotInfo[],
  platformLabel: string,
): string[] {
  if (screenshots.length === 0) {
    return ["- No screenshots were saved."];
  }

  const screenshotRows = screenshots.map((screenshot) => {
    if (screenshot.blobUrl) {
      return `| <a href="${screenshot.blobUrl}"><img src="${screenshot.blobUrl}" alt="${screenshot.fileName}" height="500" /></a> |`;
    }

    const details = [screenshot.fileName, `${screenshot.bytes} bytes`];
    if (screenshot.uploadError) {
      details.push(`upload failed: ${screenshot.uploadError}`);
    }

    return details.join(", ");
  });

  if (screenshots.some((screenshot) => screenshot.blobUrl)) {
    return [
      `| ${platformLabel} |`,
      "| --- |",
      ...screenshotRows.filter((row) => row.startsWith("|")),
    ];
  }

  return screenshotRows
    .filter((value) => !value.startsWith("|"))
    .map((row) => `- ${row}`);
}

function renderPlatformSection(report: Report): string {
  const lines = [
    `### ${report.platformLabel}`,
    "",
    `**Status:** ${report.overallStatus}`,
    "",
    report.summary || "No summary was provided.",
    "",
    "### Checked",
  ];

  if (report.checked?.length) {
    for (const item of report.checked) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- No checks were recorded.");
  }

  lines.push("", "### Issues");
  if (report.issues?.length) {
    for (const issue of report.issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push("- No issues noted.");
  }

  lines.push("", "### Screenshots");
  lines.push(...renderScreenshotRows(report.screenshots || [], report.platformLabel));

  lines.push("", "### Next steps");
  if (report.nextSteps?.length) {
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  } else {
    lines.push("- No follow-up actions were suggested.");
  }

  lines.push("", "### Metadata");
  lines.push(`- Build ID: \`${report.buildId || "n/a"}\``);
  lines.push(`- Workflow: ${report.workflowUrl || "n/a"}`);
  lines.push("", "### JSON Report", "");
  lines.push("```json");
  lines.push(JSON.stringify(report, null, 2));
  lines.push("```");

  return `${lines.join("\n")}\n`;
}

export function buildClientContext() {
  const prTitle = pr.title || "Untitled PR";
  const prBody = pr.body || "No PR body was provided.";

  return {
    prNumber: context.prNumber,
    title: prTitle,
    body: prBody,
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

function getMissingScreenshotLabels(
  screenshots: ScreenshotInfo[],
  labels: ScreenshotLabel[] | undefined,
): string[] {
  const labeledFiles = new Set(
    (labels || []).map((item) => item.fileName).filter(Boolean),
  );

  return screenshots
    .map((screenshot) => screenshot.fileName)
    .filter((fileName) => !labeledFiles.has(fileName));
}

function reportMentionsScreenshotEvidence(input: ReportInput): boolean {
  const text = [
    input.summary,
    ...(input.checked || []),
    ...(input.issues || []),
    ...(input.nextSteps || []),
  ]
    .join("\n")
    .toLowerCase();

  return text.includes("screenshot") || text.includes("evidence");
}

function reportMentionsSessionMetaFailure(input: ReportInput): boolean {
  const text = [
    input.summary,
    ...(input.checked || []),
    ...(input.issues || []),
    ...(input.nextSteps || []),
  ]
    .join("\n")
    .toLowerCase();

  return (
    text.includes("already-closed session") ||
    text.includes("closed session") ||
    text.includes("muddied") ||
    text.includes("tool-call constraint") ||
    text.includes("required tool-call")
  );
}

function hasAttemptedAgentDeviceCommand(command: string): boolean {
  return agentDeviceTrace.some((entry) => entry.normalizedCommand === command);
}

function hasSuccessfulAgentDeviceCommand(command: string): boolean {
  return agentDeviceTrace.some(
    (entry) => entry.normalizedCommand === command && entry.ok,
  );
}

function getUnseparatedScreenshotPair(): [string, string] | null {
  let lastScreenshotFileName: string | null = null;
  let hasUiChangeSinceLastScreenshot = false;

  for (const entry of agentDeviceTrace) {
    if (!entry.ok) {
      continue;
    }

    if (entry.normalizedCommand === "screenshot") {
      const currentScreenshotFileName = path.basename(
        entry.normalizedArgs[0] || "unknown screenshot",
      );

      if (lastScreenshotFileName && !hasUiChangeSinceLastScreenshot) {
        return [lastScreenshotFileName, currentScreenshotFileName];
      }

      lastScreenshotFileName = currentScreenshotFileName;
      hasUiChangeSinceLastScreenshot = false;
      continue;
    }

    if (UI_CHANGING_AGENT_DEVICE_COMMANDS.has(entry.normalizedCommand)) {
      hasUiChangeSinceLastScreenshot = true;
    }
  }

  return null;
}

export async function validateAndPersistReport(input: ReportInput) {
  const screenshots = await listScreenshots();
  if (requiresEvidenceScreenshot(input.overallStatus) && screenshots.length === 0) {
    return {
      ok: false,
      error: `Save at least one screenshot showing a relevant ${context.platformLabel} app screen in ${SCREENSHOTS_DIR} before calling write_report for overallStatus "${input.overallStatus}". If screenshots cannot be captured, use overallStatus "blocked" and explain why.`,
    };
  }
  if (requiresEvidenceScreenshot(input.overallStatus)) {
    const missingLabels = getMissingScreenshotLabels(
      screenshots,
      input.screenshotLabels,
    );
    if (missingLabels.length > 0) {
      return {
        ok: false,
        error: `Add screenshotLabels for every saved screenshot before reporting ${input.overallStatus}. Missing labels for: ${missingLabels.join(", ")}.`,
      };
    }

    const unseparatedScreenshotPair = getUnseparatedScreenshotPair();
    if (unseparatedScreenshotPair) {
      return {
        ok: false,
        error: `Screenshots should show distinct relevant states. ${unseparatedScreenshotPair[0]} and ${unseparatedScreenshotPair[1]} were captured without a UI-changing command between them. Keep one screenshot, or capture the next one after an action such as press, scroll, navigation, fill, or wait for async UI.`,
      };
    }
  }
  if (
    input.overallStatus === "blocked" &&
    screenshots.length === 0 &&
    !hasAttemptedAgentDeviceCommand("screenshot") &&
    reportMentionsScreenshotEvidence(input)
  ) {
    return {
      ok: false,
      error: `Try screenshot capture before using a blocked report for missing screenshot evidence. Call agent_device with command "screenshot" and args ["${path.join(SCREENSHOTS_DIR, `${context.platform}-evidence.png`)}"] while the app under test is foregrounded. If that screenshot command fails, report blocked with the screenshot failure.`,
    };
  }
  if (
    input.overallStatus === "blocked" &&
    screenshots.length > 0 &&
    hasSuccessfulAgentDeviceCommand("snapshot") &&
    reportMentionsSessionMetaFailure(input)
  ) {
    return {
      ok: false,
      error:
        "A blocked report needs a concrete environment or tool failure. When the app was observable, report the observed app result as passed, failed, or unsure.",
    };
  }
  await persistReport(input);
  return { ok: true };
}

export function ensureRequiredAgentQaEnvs(): void {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      "Missing required AI Gateway credentials: set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN",
    );
  }
  if (!APP_PATH) {
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
