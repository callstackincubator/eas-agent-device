import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { put } from '@vercel/blob';
import { ToolLoopAgent, gateway, jsonSchema } from 'ai';

type SkillMetadata = {
  name: string;
  description: string;
  directoryPath: string;
  skillFilePath: string;
};

type QaPlatform = 'android' | 'ios';

type ScreenshotInfo = {
  fileName: string;
  absolutePath: string;
  bytes: number;
  blobUrl?: string;
  blobDownloadUrl?: string;
  blobPathname?: string;
  uploadError?: string;
};

type AgentDeviceTraceEntry = {
  command: string;
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
  evidenceScreenshots?: string[];
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
const AGENT_DEVICE_BIN = resolveAgentDeviceBinary();
const QA_PLATFORM = normalizePlatform(process.env.QA_PLATFORM);
const APP_PATH = process.env.APP_PATH;
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const MODEL_ID = process.env.QA_MODEL || 'openai/gpt-5.4-mini';
const EMPTY_INPUT_SCHEMA = jsonSchema({
  type: 'object',
  properties: {},
  additionalProperties: false,
});
const SKILL_DIRECTORIES = [
  path.join(ROOT_DIR, 'node_modules', 'agent-device', 'skills'),
];

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

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

function parseFrontmatter(content: string): {
  name: string;
  description: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    throw new Error('No frontmatter found');
  }

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const name = nameMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  const description = descriptionMatch?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');

  if (!name || !description) {
    throw new Error('Skill frontmatter is missing name or description');
  }

  return { name, description };
}

async function discoverSkills(directories: string[]): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = [];
  const seenNames = new Set<string>();

  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDirectoryPath = path.join(directory, entry.name);
      const skillFilePath = path.join(skillDirectoryPath, 'SKILL.md');

      try {
        const content = await readFile(skillFilePath, 'utf8');
        const frontmatter = parseFrontmatter(content);

        if (seenNames.has(frontmatter.name.toLowerCase())) {
          continue;
        }

        seenNames.add(frontmatter.name.toLowerCase());
        skills.push({
          name: frontmatter.name,
          description: frontmatter.description,
          directoryPath: skillDirectoryPath,
          skillFilePath,
        });
      } catch {
        continue;
      }
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function buildSkillsPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return 'No local skills were discovered for this run.';
  }

  const skillList = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join('\n');

  return [
    'Available local skills:',
    skillList,
    '',
    'Load a skill before relying on its instructions. Use read_skill_file only for files inside the loaded skill directory.',
  ].join('\n');
}

function findSkill(skills: SkillMetadata[], name: string): SkillMetadata {
  const skill = skills.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );

  if (!skill) {
    throw new Error(`Skill not found: ${name}`);
  }

  return skill;
}

function resolveSkillFilePath(skill: SkillMetadata, relativeFilePath: string): string {
  const absolutePath = path.resolve(skill.directoryPath, relativeFilePath);
  const relativePath = path.relative(skill.directoryPath, absolutePath);
  const normalizedRelativePath = relativePath.split(path.sep).join('/');

  if (
    normalizedRelativePath === '' ||
    normalizedRelativePath.startsWith('../') ||
    normalizedRelativePath === '..'
  ) {
    throw new Error(
      `Refusing to read a path outside the skill directory: ${relativeFilePath}`,
    );
  }

  return absolutePath;
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
  const screenshots = await uploadScreenshotsToBlob(await listScreenshots());
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

function renderPlatformSection(report: Report): string {
  const screenshotByFileName = new Map(
    report.screenshots.map((screenshot) => [screenshot.fileName, screenshot]),
  );
  const lines = [
    `### ${report.platformLabel}`,
    '',
    `**Status:** ${report.overallStatus}`,
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

  lines.push('', '### Evidence');
  if (report.evidenceScreenshots?.length) {
    const evidenceRows = report.evidenceScreenshots
      .map((fileName) => screenshotByFileName.get(fileName))
      .filter((screenshot): screenshot is ScreenshotInfo => Boolean(screenshot));

    if (evidenceRows.length > 0) {
      lines.push(...renderScreenshotRows(evidenceRows, report.platformLabel));
    } else {
      lines.push('- No matching evidence screenshots were found.');
    }
  } else {
    lines.push('- No evidence screenshots were selected.');
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
  lines.push('');
  lines.push('<details>');
  lines.push(`<summary>${report.platformLabel} full report</summary>`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```');
  lines.push('</details>');

  return `${lines.join('\n')}\n`;
}

function buildPrompt(skills: SkillMetadata[]): string {
  const prTitle = pr.title || 'Untitled PR';
  const prBody = pr.body || 'No PR body was provided.';
  const platformSpecificContext =
    context.platform === 'ios'
      ? [`- Preferred iOS simulator: ${context.deviceName || 'n/a'}`]
      : [`- Preferred Android device: ${context.deviceName || 'n/a'}`];
  const platformSpecificFlow =
    context.platform === 'ios'
      ? `For iOS simulator runs, the workflow already binds the session to ${context.deviceName}. Prefer reinstall ${context.applicationId} ${context.buildPath}, then open ${context.applicationId} --relaunch. Do not pass --device, --udid, or --session in normal app commands.`
      : `For Android runs, the workflow already binds the session to ${context.deviceName || 'the booted emulator'}. Try reinstall ${context.applicationId} ${context.buildPath} first. If reinstall fails during uninstall, retry with install ${context.applicationId} ${context.buildPath}. Then open ${context.applicationId} --relaunch.`;

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
    buildSkillsPrompt(skills),
    '',
    platformSpecificFlow,
    `You must infer concise acceptance criteria from the PR, test only the highest-signal ${context.platformLabel} flows, load the relevant local skill before relying on it, save temporary screenshots into ${SCREENSHOTS_DIR}/*.png, and call write_report exactly once before finishing.`,
    'If the accessibility tree or snapshot text is inconclusive but the screenshots likely show the changed UI, use overallStatus "unsure" instead of "blocked" or "failed".',
    'When you use "unsure", include evidenceScreenshots with the screenshot file names that best represent the feature described in the PR.',
    'Do not end with plain text. Your final action must be a write_report tool call.',
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

async function main(): Promise<void> {
  await ensureArtifactsDir();
  await ensureScreenshotsDir();
  ensureRequiredAgentQaEnvs();
  const skills = await discoverSkills(SKILL_DIRECTORIES);

  const agent = new ToolLoopAgent({
    model: gateway(MODEL_ID),
    instructions: [
      `You are a ${context.platformLabel} QA agent running inside EAS Workflows.`,
      'Treat the app and repository as a black box.',
      'Infer a short list of acceptance criteria from PR metadata, focusing on user-visible behavior.',
      `Use agent-device to test the ${context.platform === 'ios' ? 'iOS simulator app bundle' : 'Android build artifact'} at the provided build path.`,
      'Use the local skills list in the prompt. Load a relevant skill before making non-trivial command choices.',
      context.platform === 'ios'
        ? `For iOS simulator runs, the workflow already booted and bound the simulator ${context.deviceName}. Reinstall the app bundle first, then open ${context.applicationId} --relaunch. Do not pass --device, --udid, --serial, or --session in normal app commands.`
        : `For Android runs, install or reinstall the APK first, then open the installed package name ${context.applicationId}. If reinstall fails during uninstall, retry with install before giving up.`,
      `Take screenshots for meaningful states and save them temporarily in ${SCREENSHOTS_DIR} with .png filenames.`,
      'After any UI transition, refresh your understanding with snapshot or diff snapshot.',
      'Do not inspect repository source files, run git commands, or modify project code. The only allowed filesystem writes are the QA report files and temporary screenshots.',
      'Do not claim success without evidence from tool results.',
      'The workflow pre-binds the mobile target. Avoid explicit routing flags like --device, --udid, --serial, or --session in normal app commands unless you are inspecting device inventory.',
      'If text-based automation evidence is inconclusive but screenshots likely show the relevant UI, report overallStatus as unsure and attach the relevant screenshot file names in evidenceScreenshots.',
      'If a prerequisite is missing or the environment is broken, mark the relevant checks as blocked.',
      'When you are done with the simulator or emulator session, prefer close --shutdown.',
      'You must call write_report exactly once before you finish.',
      'Never finish by returning plain text. Finish only by calling write_report.',
    ].join(' '),
    toolChoice: 'required',
    prepareStep: async ({ steps, stepNumber }) => {
      const hasWrittenReport = hasToolActivity(steps, 'write_report');
      const hasUsedDeviceTools = hasToolActivity(steps, 'agent_device');

      if (hasWrittenReport || !hasUsedDeviceTools || stepNumber < 6) {
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
      load_skill: {
        description:
          'Load a local skill and return its instructions plus the skill directory path.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Skill name from the available local skills list.',
            },
          },
          required: ['name'],
          additionalProperties: false,
        }),
        execute: async ({ name }: { name: string }) => {
          const skill = findSkill(skills, name);
          const content = await readFile(skill.skillFilePath, 'utf8');
          return {
            name: skill.name,
            description: skill.description,
            skillDirectory: skill.directoryPath,
            skillFilePath: skill.skillFilePath,
            content: stripFrontmatter(content),
          };
        },
      },
      read_skill_file: {
        description:
          'Read a text file inside a loaded skill directory, such as references or scripts.',
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            skillName: {
              type: 'string',
              description: 'Skill name from the available local skills list.',
            },
            path: {
              type: 'string',
              description:
                'Path relative to the skill directory, such as references/foo.md.',
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
          required: ['skillName', 'path'],
          additionalProperties: false,
        }),
        execute: async ({
          skillName,
          path: relativeFilePath,
          startLine = 1,
          maxLines = 200,
        }: {
          skillName: string;
          path: string;
          startLine?: number;
          maxLines?: number;
        }) => {
          const skill = findSkill(skills, skillName);
          const absolutePath = resolveSkillFilePath(skill, relativeFilePath);
          const content = await readFile(absolutePath, 'utf8');
          const lines = content.split('\n');
          const slice = lines.slice(
            Math.max(startLine - 1, 0),
            Math.max(startLine - 1, 0) + maxLines,
          );

          return {
            skillName: skill.name,
            absolutePath,
            startLine,
            endLine: startLine + slice.length - 1,
            content: slice.join('\n'),
          };
        },
      },
      agent_device: {
        description:
          'Run an agent-device command for mobile UI automation and screenshot capture.',
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
                `Remaining CLI arguments. Use ${SCREENSHOTS_DIR}/*.png for screenshots.`,
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
          agentDeviceTrace.push({
            command: [command, ...args].join(' '),
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
        },
      },
      write_report: {
        description:
          'Persist the final QA summary, findings, and screenshot index to artifacts/qa.',
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
            evidenceScreenshots: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Screenshot file names that best show the feature or visual change being discussed.',
            },
          },
          required: ['overallStatus', 'summary'],
          additionalProperties: false,
        }),
        execute: async (input: ReportInput) => persistReport(input),
      },
    },
  });

  const result = await agent.generate({
    prompt: buildPrompt(skills),
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
