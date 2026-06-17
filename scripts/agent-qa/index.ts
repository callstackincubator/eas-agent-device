import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { put } from '@vercel/blob';
import { ToolLoopAgent, gateway, jsonSchema } from 'ai';

type QaPlatform = 'android' | 'ios';

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

type ScreenshotLabel = {
  fileName: string;
  label: string;
};

type AgentDeviceTraceEntry = {
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

type ResultStatus = 'passed' | 'failed' | 'blocked' | 'not_tested' | 'unsure';

type ReportInput = {
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

const REPORT_STATUSES_REQUIRING_SCREENSHOT: ResultStatus[] = [
  'passed',
  'failed',
  'unsure',
];
const MIN_SCREENSHOTS_BEFORE_FORCED_REPORT = 1;
const UI_CHANGING_AGENT_DEVICE_COMMANDS = new Set([
  'back',
  'click',
  'fill',
  'gesture',
  'longpress',
  'open',
  'press',
  'scroll',
  'swipe',
  'type',
  'wait',
]);

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

type CommandOptions = {
  cwd?: string;
  allowFailure?: boolean;
};

type ExecFileError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
};

const execFile = promisify(execFileCallback);
const ROOT_DIR = process.cwd();
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts', 'qa');
const SCREENSHOTS_DIR = path.join(tmpdir(), 'agent-qa-screenshots');
const REPORT_PATH = path.join(ARTIFACTS_DIR, 'report.json');
const SECTION_PATH = path.join(ARTIFACTS_DIR, 'section.md');
const STATUS_PATH = path.join(ARTIFACTS_DIR, 'status.txt');
const AGENT_DEVICE_BIN = 'agent-device';
const QA_PLATFORM = normalizePlatform(process.env.QA_PLATFORM);
const APP_PATH = process.env.APP_PATH;
const BOOTSTRAP_ERROR = process.env.AGENT_QA_BOOTSTRAP_ERROR;
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const MODEL_ID = process.env.QA_MODEL || 'openai/gpt-5.4-mini';
const EMPTY_INPUT_SCHEMA = jsonSchema({
  type: 'object',
  properties: {},
  additionalProperties: false,
});
const pr = parseJson<ParsedPr>(process.env.PR_JSON, {});
const context = {
  platform: QA_PLATFORM,
  platformLabel: QA_PLATFORM === 'ios' ? 'iOS' : 'Android',
  buildId: process.env.BUILD_ID || '',
  buildPath: APP_PATH || '',
  prNumber: Number(pr.number || 0),
  workflowUrl: process.env.WORKFLOW_URL || '',
  applicationId: process.env.APPLICATION_ID || '',
  deviceName:
    process.env.DEVICE_NAME ||
    (QA_PLATFORM === 'ios'
      ? process.env.AGENT_DEVICE_IOS_DEVICE || ''
      : process.env.AGENT_DEVICE_ANDROID_DEVICE || ''),
};
const agentDeviceTrace: AgentDeviceTraceEntry[] = [];

function normalizePlatform(value: string | undefined): QaPlatform {
  return value === 'ios' ? 'ios' : 'android';
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
  if (command !== 'press' && command !== 'click') {
    return null;
  }

  const target = args.join(' ').trim();
  if (
    isNumericTarget(args[0]) && isNumericTarget(args[1]) ||
    isRefTarget(target) ||
    isSelectorTarget(target)
  ) {
    return null;
  }

  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr:
      'Error (INVALID_ARGS): Bare labels are not valid targets; use @eN from snapshot or label="...".',
  };
}

function rejectInvalidCommandName(command: string): CommandResult | null {
  if (!command.trim()) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr:
        'Error (INVALID_ARGS): Missing agent-device command. Use command for the subcommand and args for flags or arguments.',
    };
  }

  if (!/\s/.test(command.trim())) {
    return null;
  }

  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr:
      'Error (INVALID_ARGS): command must be a single agent-device subcommand. Put flags and arguments in args, for example command "snapshot" with args ["-i"].',
  };
}

function normalizeAgentDeviceArgs(command: string, args: string[]): string[] {
  if (command === 'help' && args.length === 0) {
    return ['workflow'];
  }

  return args;
}

function requiresEvidenceScreenshot(status: ResultStatus): boolean {
  return REPORT_STATUSES_REQUIRING_SCREENSHOT.includes(status);
}

function humanizeScreenshotLabel(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const words = stem
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(' ') || fileName;
}

function ensureRequiredAgentQaEnvs(): void {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      'Missing required environment variable: AI_GATEWAY_API_KEY',
    );
  }
  if (!APP_PATH) {
    throw new Error('Missing required environment variable: APP_PATH');
  }
  if (!context.applicationId) {
    throw new Error('Missing required environment variable: APPLICATION_ID');
  }
  if (context.platform === 'ios' && !context.deviceName) {
    throw new Error(
      'Missing required environment variable: AGENT_DEVICE_IOS_DEVICE',
    );
  }
}

async function runCommand(
  file: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const { cwd = ROOT_DIR, allowFailure = false } = options;

  try {
    const result = await execFile(file, args, {
      cwd,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    return {
      ok: true,
      exitCode: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (unknownError) {
    const error = unknownError as ExecFileError;
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr =
      typeof error.stderr === 'string' ? error.stderr : error.message;
    const exitCode = typeof error.code === 'number' ? error.code : 1;

    if (!allowFailure) {
      throw new Error(
        [`Command failed: ${file} ${args.join(' ')}`, stderr || stdout]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    return {
      ok: false,
      exitCode,
      stdout,
      stderr,
    };
  }
}

async function runAgentDeviceCommand(command: string, args: string[] = []): Promise<{
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
    preflightResult ||
    (await runCommand(AGENT_DEVICE_BIN, argv, {
      allowFailure: true,
    }));

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

async function ensureArtifactsDir(): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
}

async function ensureScreenshotsDir(): Promise<void> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
}

async function listScreenshots(): Promise<ScreenshotInfo[]> {
  if (!existsSync(SCREENSHOTS_DIR)) {
    return [];
  }

  const entries = await readdir(SCREENSHOTS_DIR);
  const screenshots: ScreenshotInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.png')) {
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
          'agent-qa',
          context.platform,
          context.prNumber ? `pr-${context.prNumber}` : 'pr-unknown',
          context.buildId || 'local-build',
          screenshot.fileName,
        ];
        const pathname = pathnameParts.join('/');
        const blob = await put(pathname, fileBuffer, {
          access: 'public',
          addRandomSuffix: true,
          contentType: 'image/png',
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

async function writeBlockedReport(error: Error): Promise<void> {
  const summary: ReportInput = {
    overallStatus: 'blocked',
    summary: error.message,
    checked: [
      `Attempted to run ${context.platformLabel} QA agent on PR changes`,
    ],
    issues: [error.message],
    nextSteps: [
      'Check the workflow logs for command failures.',
      `Verify AI_GATEWAY_API_KEY, ${context.platformLabel} build availability, and ${context.platform === 'ios' ? 'simulator' : 'emulator'} configuration.`,
    ],
  };

  await persistReport(summary);
}

async function persistReport(reportInput: ReportInput) {
  await ensureArtifactsDir();
  await ensureScreenshotsDir();
  const screenshotLabelMap = new Map(
    (reportInput.screenshotLabels || [])
      .filter(
        (item): item is ScreenshotLabel =>
          Boolean(item?.fileName) && Boolean(item?.label),
      )
      .map((item) => [item.fileName, item.label.trim()]),
  );
  const screenshots = (await uploadScreenshotsToBlob(await listScreenshots())).map(
    (screenshot) => ({
      ...screenshot,
      label:
        screenshotLabelMap.get(screenshot.fileName) ||
        humanizeScreenshotLabel(screenshot.fileName),
    }),
  );
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

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(SECTION_PATH, trim(renderPlatformSection(report), 16000), 'utf8');
  await writeFile(STATUS_PATH, `${report.overallStatus}\n`, 'utf8');
}

function renderScreenshotRows(
  screenshots: ScreenshotInfo[],
  platformLabel: string,
): string[] {
  if (screenshots.length === 0) {
    return ['- No screenshots were saved.'];
  }

  const screenshotRows = screenshots.map((screenshot) => {
    if (screenshot.blobUrl) {
      return `| <a href="${screenshot.blobUrl}"><img src="${screenshot.blobUrl}" alt="${screenshot.fileName}" height="500" /></a> |`;
    }

    const details = [screenshot.fileName, `${screenshot.bytes} bytes`];
    if (screenshot.uploadError) {
      details.push(`upload failed: ${screenshot.uploadError}`);
    }

    return details.join(', ');
  });

  if (screenshots.some((screenshot) => screenshot.blobUrl)) {
    return [
      `| ${platformLabel} |`,
      '| --- |',
      ...screenshotRows.filter((row) => row.startsWith('|')),
    ];
  }

  return screenshotRows
    .filter((value) => !value.startsWith('|'))
    .map((row) => `- ${row}`);
}

function getStatusEmoji(status: ResultStatus): string {
  switch (status) {
    case 'passed':
      return '✅';
    case 'failed':
      return '❌';
    case 'blocked':
      return '⛔';
    case 'unsure':
      return '🤔';
    case 'not_tested':
    default:
      return '⚪';
  }
}

function renderPlatformSection(report: Report): string {
  const lines = [
    `### ${report.platformLabel}`,
    '',
    `**Status:** ${getStatusEmoji(report.overallStatus)} ${report.overallStatus}`,
    '',
    report.summary || 'No summary was provided.',
    '',
    '### Checked',
  ];

  if (report.checked?.length) {
    for (const item of report.checked) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('- No checks were recorded.');
  }

  lines.push('', '### Issues');
  if (report.issues?.length) {
    for (const issue of report.issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push('- No issues noted.');
  }

  lines.push('', '### Screenshots');
  lines.push(...renderScreenshotRows(report.screenshots || [], report.platformLabel));

  lines.push('', '### Next steps');
  if (report.nextSteps?.length) {
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  } else {
    lines.push('- No follow-up actions were suggested.');
  }

  lines.push('', '### Metadata');
  lines.push(`- Build ID: \`${report.buildId || 'n/a'}\``);
  lines.push(`- Workflow: ${report.workflowUrl || 'n/a'}`);
  lines.push('', '### JSON Report', '');
  lines.push('```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```');

  return `${lines.join('\n')}\n`;
}

function buildPrompt(): string {
  const prTitle = pr.title || 'Untitled PR';
  const prBody = pr.body || 'No PR body was provided.';
  const platformSpecificContext =
    context.platform === 'ios'
      ? [`- Preferred iOS simulator: ${context.deviceName || 'n/a'}`]
      : [`- Preferred Android device: ${context.deviceName || 'n/a'}`];
  const platformSpecificFlow =
    context.platform === 'ios'
      ? `For iOS simulator runs, the workflow already booted the app on ${context.deviceName}. Normal app commands can use the pre-bound simulator without --device, --udid, or --session.`
      : `For Android runs, the workflow already booted the app on ${context.deviceName || 'the booted emulator'}.`;

  return [
    `Review this pull request and run a lightweight ${context.platformLabel} QA pass.`,
    '',
    `PR #${context.prNumber}: ${prTitle}`,
    '',
    prBody,
    '',
    'Execution context:',
    `- Build ID: ${context.buildId || 'n/a'}`,
    `- Build path: ${context.buildPath || 'n/a'}`,
    `- Platform: ${context.platformLabel}`,
    `- Application id: ${context.applicationId || 'n/a'}`,
    ...platformSpecificContext,
    `- Workflow URL: ${context.workflowUrl || 'n/a'}`,
    `- Temporary screenshot directory: ${SCREENSHOTS_DIR}`,
    '',
    platformSpecificFlow,
    'Task flow:',
    '1. Infer concise acceptance criteria from the PR metadata.',
    '2. Use agent_device help workflow, then verify the app under test is foregrounded.',
    `3. Exercise the shortest high-signal ${context.platformLabel} path that proves the user-visible change.`,
    '4. Capture screenshots only when they show distinct, relevant states.',
    '5. Finish with exactly one write_report call.',
    '',
    'Screenshot examples:',
    `- New tab or navigation: capture the source screen before pressing the target, then capture the destination screen after the transition.`,
    '- Single screen already showing the changed UI: one final-state screenshot is enough.',
    '- Scrollable changed screen: capture the top state, then scroll and capture the below-the-fold state when that content matters.',
    '- Use labels that describe the visible state, such as "Home before Ship tab", "Ship screen", or "Ship screen scrolled".',
  ].join('\n');
}

function hasToolActivity(
  steps: Array<{
    toolCalls?: Array<{ toolName?: string }>;
    toolResults?: Array<{ toolName?: string }>;
  }>,
  toolName: string,
): boolean {
  return steps.some((step) => {
    const calledTool = step.toolCalls?.some((call) => call.toolName === toolName);
    const completedTool = step.toolResults?.some(
      (result) => result.toolName === toolName,
    );
    return Boolean(calledTool || completedTool);
  });
}

function hasAttemptedAgentDeviceCommand(command: string): boolean {
  return agentDeviceTrace.some((entry) => entry.normalizedCommand === command);
}

function hasSuccessfulAgentDeviceCommand(command: string): boolean {
  return agentDeviceTrace.some(
    (entry) => entry.normalizedCommand === command && entry.ok,
  );
}

function reportMentionsScreenshotEvidence(input: ReportInput): boolean {
  const text = [
    input.summary,
    ...(input.checked || []),
    ...(input.issues || []),
    ...(input.nextSteps || []),
  ]
    .join('\n')
    .toLowerCase();

  return text.includes('screenshot') || text.includes('evidence');
}

function reportMentionsSessionMetaFailure(input: ReportInput): boolean {
  const text = [
    input.summary,
    ...(input.checked || []),
    ...(input.issues || []),
    ...(input.nextSteps || []),
  ]
    .join('\n')
    .toLowerCase();

  return (
    text.includes('already-closed session') ||
    text.includes('closed session') ||
    text.includes('muddied') ||
    text.includes('tool-call constraint') ||
    text.includes('required tool-call')
  );
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

function getUnseparatedScreenshotPair(): [string, string] | null {
  let lastScreenshotFileName: string | null = null;
  let hasUiChangeSinceLastScreenshot = false;

  for (const entry of agentDeviceTrace) {
    if (!entry.ok) {
      continue;
    }

    if (entry.normalizedCommand === 'screenshot') {
      const currentScreenshotFileName = path.basename(
        entry.normalizedArgs[0] || 'unknown screenshot',
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

async function main(): Promise<void> {
  await ensureArtifactsDir();
  await ensureScreenshotsDir();
  ensureRequiredAgentQaEnvs();
  if (BOOTSTRAP_ERROR) {
    await writeBlockedReport(new Error(BOOTSTRAP_ERROR));
    return;
  }

  const agent = new ToolLoopAgent({
    model: gateway(MODEL_ID),
    instructions: [
      `You are a ${context.platformLabel} QA agent running inside EAS Workflows.`,
      'Treat the app and repository as a black box.',
      'The workflow has already installed and launched the app before the agent starts.',
      'Start with get_pr_context and agent_device help workflow, then infer acceptance criteria from user-visible PR behavior.',
      `Verify ${context.applicationId} is foregrounded with appstate or a successful open --relaunch before collecting evidence.`,
      `When appstate has no tracked foreground app, or a snapshot shows AgentDeviceRunner, call agent_device with command "open" and args ["${context.applicationId}", "--relaunch"], wait briefly, and verify again.`,
      'AgentDeviceRunner is automation infrastructure; the app under test is the evidence source.',
      context.platform === 'ios'
        ? `For iOS simulator runs, the workflow already booted and bound the simulator ${context.deviceName}. Normal app commands use the pre-bound simulator.`
        : 'For Android runs, the workflow already booted and bound the emulator.',
      'Use agent_device command as exactly one subcommand and put flags in args, for example command "snapshot" with args ["-i"].',
      'Use @eN refs or formal selectors for interactions, for example press @e18 or press label="Ship". Bare label text is an invalid target.',
      'Use plain snapshot for visible text checks and snapshot -i for choosing interaction refs.',
      'Refresh state with snapshot after press, fill, scroll, navigation, waits for async UI, or other UI transitions.',
      `Capture screenshots as visual evidence in ${SCREENSHOTS_DIR} with .png filenames. Screenshots are useful when they show distinct relevant states; one final-state screenshot is enough for a single-screen change.`,
      'For navigation changes, capture the source state before the action and the destination state after the action. For scrollable changed screens, capture the top state and a scrolled state when below-the-fold content matters.',
      'Use screenshot filenames and labels that describe the visible state. Reserve words like before, after, and final for screenshots separated by a UI-changing action.',
      'Inspect screenshots for obvious visual issues such as clipping, overflow, overlap, truncation, partial elements, and unsafe edge spacing. Pair this with accessibility snapshot text for semantic checks.',
      'Use overallStatus passed for satisfied acceptance criteria, failed for user-visible regressions, unsure for incomplete but useful evidence, and blocked for concrete prerequisite or environment/tool failures.',
      'Use write_report exactly once as the final action. Include checked items, issues, nextSteps, and screenshotLabels for every saved screenshot.',
    ].join(' '),
    toolChoice: 'required',
    prepareStep: async ({ steps, stepNumber }) => {
      const hasWrittenReport = existsSync(SECTION_PATH);
      const hasUsedDeviceTools = hasToolActivity(steps, 'agent_device');
      const screenshotCount = (await listScreenshots()).length;
      const hasAttemptedScreenshot = hasAttemptedAgentDeviceCommand('screenshot');

      if (
        hasWrittenReport ||
        !hasUsedDeviceTools ||
        stepNumber < 8 ||
        (
          screenshotCount < MIN_SCREENSHOTS_BEFORE_FORCED_REPORT &&
          !(hasAttemptedScreenshot && stepNumber >= 12)
        )
      ) {
        return undefined;
      }

      return {
        activeTools: ['write_report'],
        toolChoice: { type: 'tool', toolName: 'write_report' },
      };
    },
    tools: {
      get_pr_context: {
        description:
          'Read the GitHub pull request context and workflow metadata for this QA run.',
        inputSchema: EMPTY_INPUT_SCHEMA,
        execute: async () => ({
          prNumber: context.prNumber,
          title: pr.title || '',
          body: pr.body || '',
          labels: Array.isArray(pr.labels)
            ? pr.labels.map((label) => label.name).filter(Boolean)
            : [],
          draft: Boolean(pr.draft),
          buildId: context.buildId,
          buildPath: context.buildPath,
          workflowUrl: context.workflowUrl,
          platform: context.platform,
          platformLabel: context.platformLabel,
          applicationId: context.applicationId,
          deviceName: context.deviceName,
        }),
      },
      agent_device: {
        description:
          'Run an agent-device command for mobile UI automation and screenshot capture. Use help workflow first. Interactions accept coordinates, @eN refs, or formal selectors such as label="Ship".',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'Exactly one agent-device subcommand, such as help, devices, reinstall, open, snapshot, press, fill, or screenshot. Put flags and arguments in args.',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description:
                `Remaining CLI arguments. Use ["workflow"] for help workflow. Use ${SCREENSHOTS_DIR}/*.png for screenshots. press/click targets use x y coordinates, @eN refs, or formal selectors like label="...".`,
            },
          },
          required: ['command'],
          additionalProperties: false,
        }),
        execute: async ({
          command,
          args = [],
        }: {
          command: string;
          args?: string[];
        }) => runAgentDeviceCommand(command, args),
      },
      write_report: {
        description:
          'Persist the final QA summary, findings, and screenshot index to artifacts/qa. Passed, failed, and unsure reports require at least one saved screenshot of a relevant app screen.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            overallStatus: {
              type: 'string',
              enum: ['passed', 'failed', 'blocked', 'not_tested', 'unsure'],
            },
            summary: {
              type: 'string',
            },
            checked: {
              type: 'array',
              items: { type: 'string' },
            },
            issues: {
              type: 'array',
              items: { type: 'string' },
            },
            nextSteps: {
              type: 'array',
              items: { type: 'string' },
            },
            screenshotLabels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  fileName: {
                    type: 'string',
                    description: 'Saved screenshot file name, including .png.',
                  },
                  label: {
                    type: 'string',
                    description:
                      'Very short route or state label for this screenshot, such as Home or Welcome screen.',
                  },
                },
                required: ['fileName', 'label'],
                additionalProperties: false,
              },
            },
          },
          required: ['overallStatus', 'summary'],
          additionalProperties: false,
        }),
        execute: async (input: ReportInput) => {
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
                error: `Add screenshotLabels for every saved screenshot before reporting ${input.overallStatus}. Missing labels for: ${missingLabels.join(', ')}.`,
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
            input.overallStatus === 'blocked' &&
            screenshots.length === 0 &&
            !hasAttemptedAgentDeviceCommand('screenshot') &&
            reportMentionsScreenshotEvidence(input)
          ) {
            return {
              ok: false,
              error: `Try screenshot capture before using a blocked report for missing screenshot evidence. Call agent_device with command "screenshot" and args ["${path.join(SCREENSHOTS_DIR, `${context.platform}-evidence.png`)}"] while the app under test is foregrounded. If that screenshot command fails, report blocked with the screenshot failure.`,
            };
          }
          if (
            input.overallStatus === 'blocked' &&
            screenshots.length > 0 &&
            hasSuccessfulAgentDeviceCommand('snapshot') &&
            reportMentionsSessionMetaFailure(input)
          ) {
            return {
              ok: false,
              error:
                'A blocked report needs a concrete environment or tool failure. When the app was observable, report the observed app result as passed, failed, or unsure.',
            };
          }

          await persistReport(input);
          return { ok: true };
        },
      },
    },
  });

  const result = await agent.generate({
    prompt: buildPrompt(),
  });

  if (result.text) {
    console.log(trim(`Agent finished with final text:\n${result.text}`, 4000));
  }

  if (!existsSync(SECTION_PATH)) {
    await persistReport({
      overallStatus: 'blocked',
      summary: result.text || 'The agent completed without calling write_report.',
      checked: [`Produce a ${context.platformLabel} QA report`],
      issues: ['The write_report tool was not called by the agent.'],
      nextSteps: [
        'Inspect the workflow logs and tighten the agent instructions.',
      ],
    });
    console.log(
      `Fallback QA report written to ${SECTION_PATH} because write_report was not called.`,
    );
    return;
  }

  console.log(`QA report written to ${SECTION_PATH}`);
}

try {
  await main();
} catch (unknownError) {
  const message =
    unknownError instanceof Error
      ? unknownError
      : new Error(String(unknownError));
  console.error(message);
  await writeBlockedReport(message);
  process.exitCode = 1;
}
