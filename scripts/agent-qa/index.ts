import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { ToolLoopAgent, gateway, jsonSchema, stepCountIs, tool } from 'ai';

type ChangedFiles = {
  comparisonTarget: string;
  files: string[];
  statSummary: string;
};

type ScreenshotInfo = {
  fileName: string;
  absolutePath: string;
  bytes: number;
};

type ResultStatus = 'passed' | 'failed' | 'blocked' | 'not_tested';

type ReportInput = {
  overallStatus: ResultStatus;
  summary: string;
  checked?: string[];
  issues?: string[];
  nextSteps?: string[];
  buildId?: string;
  workflowUrl?: string;
};

type Report = ReportInput & {
  generatedAt: string;
  model: string;
  prNumber: number;
  repository: string;
  screenshots: ScreenshotInfo[];
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

type CommandOptions = {
  cwd?: string;
  allowFailure?: boolean;
};

type BootResult =
  | {
      attempted: false;
      reason: string;
    }
  | {
      attempted: true;
      command: string;
      ok: boolean;
      stdout: string;
      stderr: string;
    };

type ExecFileError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string;
};

const execFile = promisify(execFileCallback);
const ROOT_DIR = process.cwd();
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts', 'qa');
const COMMENT_PATH = path.join(ARTIFACTS_DIR, 'comment.md');
const REPORT_PATH = path.join(ARTIFACTS_DIR, 'report.json');
const AGENT_DEVICE_BIN = resolveAgentDeviceBinary();
const APK_PATH = process.env.APK_PATH;
const MODEL_ID = process.env.QA_MODEL || 'openai/gpt-5.1-mini';
const AGENT_DEVICE_SKILL_PATH = path.join(
  ROOT_DIR,
  'node_modules',
  'agent-device',
  'skills',
  'agent-device',
  'SKILL.md',
);

const pr = parseJson<ParsedPr>(process.env.PR_JSON, {});
const context = {
  buildId: process.env.BUILD_ID || '',
  buildPath: APK_PATH || '',
  baseRef: process.env.BASE_REF || '',
  headSha: process.env.HEAD_SHA || '',
  prNumber: Number(process.env.PR_NUMBER || pr.number || 0),
  repository: process.env.GITHUB_REPOSITORY || '',
  repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER || '',
  workflowUrl: process.env.WORKFLOW_URL || '',
  androidApplicationId: process.env.ANDROID_APPLICATION_ID || '',
  emulatorDevice: process.env.AGENT_DEVICE_ANDROID_DEVICE || '',
  androidSerial: process.env.AGENT_DEVICE_ANDROID_SERIAL || '',
};

let cachedChangedFiles: ChangedFiles | undefined;

function resolveAgentDeviceBinary(): string {
  const local = path.join(ROOT_DIR, 'node_modules', '.bin', 'agent-device');
  if (existsSync(local)) {
    return local;
  }
  return 'agent-device';
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

function ensureRequiredAgentQaEnvs(): void {
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      'Missing required environment variable: AI_GATEWAY_API_KEY',
    );
  }
  if (!process.env.APK_PATH) {
    throw new Error('Missing required environment variable: APK_PATH');
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

async function ensureArtifactsDir(): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
}

async function ensureBaseRefFetched(): Promise<void> {
  if (!context.baseRef) {
    return;
  }

  await runCommand(
    'git',
    [
      'fetch',
      'origin',
      `refs/heads/${context.baseRef}:refs/remotes/origin/${context.baseRef}`,
      '--depth=50',
    ],
    {
      allowFailure: true,
    },
  );
}

async function getChangedFiles(): Promise<ChangedFiles> {
  if (cachedChangedFiles) {
    return cachedChangedFiles;
  }

  await ensureBaseRefFetched();
  const comparisonTarget = context.baseRef
    ? `origin/${context.baseRef}...${context.headSha || 'HEAD'}`
    : 'HEAD~1...HEAD';

  const [names, statSummary] = await Promise.all([
    runCommand('git', ['diff', '--name-only', comparisonTarget]),
    runCommand('git', ['diff', '--stat', comparisonTarget]),
  ]);

  cachedChangedFiles = {
    comparisonTarget,
    files: names.stdout
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean),
    statSummary: trim(statSummary.stdout || statSummary.stderr, 4000),
  };

  return cachedChangedFiles;
}

function assertWithinRoot(absolutePath: string): string {
  const relativePath = path.relative(ROOT_DIR, absolutePath);
  const normalizedRelativePath = relativePath.split(path.sep).join('/');

  if (
    normalizedRelativePath === '' ||
    normalizedRelativePath.startsWith('../') ||
    normalizedRelativePath === '..'
  ) {
    throw new Error(
      `Refusing to read a path outside the repository root: ${absolutePath}`,
    );
  }

  return normalizedRelativePath;
}

async function readFileExcerpt(
  filePath: string,
  startLine = 1,
  maxLines = 200,
) {
  const absolutePath = path.resolve(ROOT_DIR, filePath);
  const relativePath = assertWithinRoot(absolutePath);
  const changedFiles = await getChangedFiles();

  if (!changedFiles.files.includes(relativePath)) {
    throw new Error(
      `Refusing to read ${relativePath}. The read_file_excerpt tool is limited to files changed in this pull request.`,
    );
  }

  const content = await readFile(absolutePath, 'utf8');
  const lines = content.split('\n');
  const slice = lines.slice(
    Math.max(startLine - 1, 0),
    Math.max(startLine - 1, 0) + maxLines,
  );

  return {
    absolutePath,
    relativePath,
    startLine,
    endLine: startLine + slice.length - 1,
    content: slice.join('\n'),
  };
}

async function maybeBootAndroidEmulator(): Promise<BootResult> {
  if (!context.emulatorDevice) {
    return {
      attempted: false,
      reason: 'AGENT_DEVICE_ANDROID_DEVICE was not set.',
    };
  }

  const args = [
    'boot',
    '--platform',
    'android',
    '--device',
    context.emulatorDevice,
    '--headless',
  ];
  if (context.androidSerial) {
    args.push('--serial', context.androidSerial);
  }

  const result = await runCommand(AGENT_DEVICE_BIN, args, {
    allowFailure: true,
  });
  return {
    attempted: true,
    command: [AGENT_DEVICE_BIN, ...args].join(' '),
    ok: result.ok,
    stdout: trim(result.stdout, 3000),
    stderr: trim(result.stderr, 3000),
  };
}

async function listScreenshots(): Promise<ScreenshotInfo[]> {
  if (!existsSync(ARTIFACTS_DIR)) {
    return [];
  }

  const entries = await readdir(ARTIFACTS_DIR);
  const screenshots: ScreenshotInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.png')) {
      continue;
    }

    const absolutePath = path.join(ARTIFACTS_DIR, entry);
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

async function writeBlockedReport(error: Error): Promise<void> {
  const summary: ReportInput = {
    overallStatus: 'blocked',
    summary: error.message,
    checked: ['Attempted to run Android QA agent on PR changes'],
    issues: [error.message],
    nextSteps: [
      'Check the workflow logs for command failures.',
      'Verify AI_GATEWAY_API_KEY, Android build availability, and emulator configuration.',
    ],
    buildId: context.buildId,
    workflowUrl: context.workflowUrl,
  };

  await persistReport(summary);
}

async function persistReport(reportInput: ReportInput) {
  await ensureArtifactsDir();
  const screenshots = await listScreenshots();
  const report: Report = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    buildId: context.buildId,
    workflowUrl: context.workflowUrl,
    prNumber: context.prNumber,
    repository: context.repository,
    screenshots,
    ...reportInput,
  };

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(COMMENT_PATH, trim(renderComment(report), 12000), 'utf8');

  return {
    reportPath: REPORT_PATH,
    commentPath: COMMENT_PATH,
    screenshotCount: screenshots.length,
  };
}

function renderComment(report: Report): string {
  const lines = [
    '## Agent QA',
    '',
    `**Overall status:** ${report.overallStatus}`,
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
  if (report.screenshots?.length) {
    for (const screenshot of report.screenshots) {
      lines.push(`- ${screenshot.fileName} (${screenshot.bytes} bytes)`);
    }
  } else {
    lines.push('- No screenshots were saved.');
  }

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

  return `${lines.join('\n')}\n`;
}

function buildPrompt(): string {
  const prTitle = pr.title || 'Untitled PR';
  const prBody = pr.body || 'No PR body was provided.';

  return [
    'Review this pull request and run a lightweight Android QA pass.',
    '',
    `PR #${context.prNumber}: ${prTitle}`,
    '',
    prBody,
    '',
    'Execution context:',
    `- Build ID: ${context.buildId || 'n/a'}`,
    `- Build path: ${context.buildPath || 'n/a'}`,
    `- Android application id: ${context.androidApplicationId || 'n/a'}`,
    `- Preferred emulator device: ${context.emulatorDevice || 'n/a'}`,
    `- Preferred Android serial: ${context.androidSerial || 'n/a'}`,
    `- Workflow URL: ${context.workflowUrl || 'n/a'}`,
    `- agent-device skill: ${AGENT_DEVICE_SKILL_PATH}`,
    '',
    'You must infer concise acceptance criteria from the PR, test only the highest-signal Android flows, consult the packaged agent-device skill before operating unfamiliar commands, save screenshots into artifacts/qa/*.png, and call write_report exactly once before finishing.',
  ].join('\n');
}

async function main(): Promise<void> {
  await ensureArtifactsDir();
  ensureRequiredAgentQaEnvs();

  const emulatorBoot = await maybeBootAndroidEmulator();
  if (emulatorBoot.attempted) {
    console.log('Android emulator boot attempt:', emulatorBoot);
  }

  const agent = new ToolLoopAgent({
    model: gateway(MODEL_ID),
    stopWhen: stepCountIs(20),
    instructions: [
      'You are an Android QA agent running inside EAS Workflows.',
      'First inspect the PR context and changed files.',
      'Infer a short list of acceptance criteria focused on user-visible behavior.',
      'Use agent-device to test the Android APK at the provided build path.',
      'The installed agent-device package includes a skill file at node_modules/agent-device/skills/agent-device/SKILL.md. Read that skill before making non-trivial command choices.',
      'For installation, prefer: reinstall QAApp <build_path> --platform android, then open <application_id> --platform android --session qa-android --relaunch.',
      'Take screenshots for meaningful states and save them in artifacts/qa with .png filenames.',
      'After any UI transition, refresh your understanding with snapshot or diff snapshot.',
      'Do not claim success without evidence from tool results.',
      'If a prerequisite is missing or the environment is broken, mark the relevant checks as blocked.',
      'You must call write_report exactly once before you finish.',
    ].join(' '),
    tools: {
      get_pr_context: tool({
        description:
          'Read the GitHub pull request context and workflow metadata for this QA run.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => ({
          repository: context.repository,
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
          androidApplicationId: context.androidApplicationId,
          emulatorDevice: context.emulatorDevice,
          androidSerial: context.androidSerial,
        }),
      }),
      get_changed_files: tool({
        description:
          'List changed files for the PR and a compact git diff stat summary.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => getChangedFiles(),
      }),
      read_file_excerpt: tool({
        description:
          'Read a file from the repository with line numbers for changed-file inspection.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Repository-relative file path to read.',
            },
            startLine: {
              type: 'integer',
              minimum: 1,
              description: '1-based line number to start reading from.',
            },
            maxLines: {
              type: 'integer',
              minimum: 1,
              maximum: 400,
              description: 'Maximum number of lines to read.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        }),
        execute: async ({
          path: filePath,
          startLine = 1,
          maxLines = 200,
        }: {
          path: string;
          startLine?: number;
          maxLines?: number;
        }) => readFileExcerpt(filePath, startLine, maxLines),
      }),
      read_agent_device_skill: tool({
        description:
          'Read the packaged agent-device skill file that ships with node_modules/agent-device.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            startLine: {
              type: 'integer',
              minimum: 1,
              description: '1-based line number to start reading from.',
            },
            maxLines: {
              type: 'integer',
              minimum: 1,
              maximum: 400,
              description: 'Maximum number of lines to read.',
            },
          },
          additionalProperties: false,
        }),
        execute: async ({
          startLine = 1,
          maxLines = 200,
        }: {
          startLine?: number;
          maxLines?: number;
        }) => {
          const absolutePath = AGENT_DEVICE_SKILL_PATH;
          const content = await readFile(absolutePath, 'utf8');
          const lines = content.split('\n');
          const slice = lines.slice(
            Math.max(startLine - 1, 0),
            Math.max(startLine - 1, 0) + maxLines,
          );

          return {
            absolutePath,
            startLine,
            endLine: startLine + slice.length - 1,
            content: slice.join('\n'),
          };
        },
      }),
      agent_device: tool({
        description:
          'Run an agent-device command for Android UI automation and screenshot capture.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'The first agent-device subcommand to run, such as devices, reinstall, open, snapshot, press, fill, or screenshot.',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Remaining CLI arguments. Use artifacts/qa/*.png for screenshots.',
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
        }) => {
          const result = await runCommand(
            AGENT_DEVICE_BIN,
            [command, ...args],
            { allowFailure: true },
          );
          return {
            ok: result.ok,
            exitCode: result.exitCode,
            stdout: trim(result.stdout, 8000),
            stderr: trim(result.stderr, 4000),
            json: parseJson(result.stdout, null as unknown),
          };
        },
      }),
      write_report: tool({
        description:
          'Persist the final QA summary, findings, and screenshot index to artifacts/qa.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            overallStatus: {
              type: 'string',
              enum: ['passed', 'failed', 'blocked', 'not_tested'],
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
          },
          required: ['overallStatus', 'summary'],
          additionalProperties: false,
        }),
        execute: async (input: ReportInput) => persistReport(input),
      }),
    },
  });

  const result = await agent.generate({
    prompt: buildPrompt(),
  });

  console.log(trim(result.text || 'Agent completed without final text.', 4000));

  if (!existsSync(COMMENT_PATH)) {
    await persistReport({
      overallStatus: 'blocked',
      summary: 'The agent completed without calling write_report.',
      checked: ['Produce a QA report'],
      issues: ['The write_report tool was not called by the agent.'],
      nextSteps: [
        'Inspect the workflow logs and tighten the agent instructions.',
      ],
    });
    throw new Error('The QA agent did not write a report.');
  }
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
