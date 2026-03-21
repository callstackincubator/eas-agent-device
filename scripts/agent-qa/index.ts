import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

type ScreenshotInfo = {
  fileName: string;
  absolutePath: string;
  bytes: number;
  blobUrl?: string;
  blobDownloadUrl?: string;
  blobPathname?: string;
  uploadError?: string;
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
const BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const MODEL_ID = process.env.QA_MODEL || 'openai/gpt-5-mini';
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
  buildId: process.env.BUILD_ID || '',
  buildPath: APK_PATH || '',
  prNumber: Number(pr.number || 0),
  workflowUrl: process.env.WORKFLOW_URL || '',
  androidApplicationId: process.env.ANDROID_APPLICATION_ID || '',
  emulatorDevice: process.env.AGENT_DEVICE_ANDROID_DEVICE || '',
  androidSerial: process.env.AGENT_DEVICE_ANDROID_SERIAL || '',
};

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
  const screenshots = await uploadScreenshotsToBlob(await listScreenshots());
  const report: Report = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    buildId: context.buildId,
    workflowUrl: context.workflowUrl,
    prNumber: context.prNumber,
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
      const details = [`${screenshot.bytes} bytes`];

      if (screenshot.blobUrl) {
        lines.push(
          `- [${screenshot.fileName}](${screenshot.blobUrl}) (${details.join(', ')})`,
        );
        continue;
      }

      if (screenshot.uploadError) {
        details.push(`upload failed: ${screenshot.uploadError}`);
      }

      lines.push(`- ${screenshot.fileName} (${details.join(', ')})`);
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

function buildPrompt(skills: SkillMetadata[]): string {
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
    '',
    buildSkillsPrompt(skills),
    '',
    'You must infer concise acceptance criteria from the PR, test only the highest-signal Android flows, load the relevant local skill before relying on it, save screenshots into artifacts/qa/*.png, and call write_report exactly once before finishing.',
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
  ensureRequiredAgentQaEnvs();
  const skills = await discoverSkills(SKILL_DIRECTORIES);

  const agent = new ToolLoopAgent({
    model: gateway(MODEL_ID),
    instructions: [
      'You are an Android QA agent running inside EAS Workflows.',
      'Treat the app and repository as a black box.',
      'Infer a short list of acceptance criteria from PR metadata, focusing on user-visible behavior.',
      'Use agent-device to test the Android APK at the provided build path.',
      'Use the local skills list in the prompt. Load a relevant skill before making non-trivial command choices.',
      'For installation, prefer: reinstall QAApp <build_path> --platform android, then open <application_id> --platform android --session qa-android --relaunch.',
      'Take screenshots for meaningful states and save them in artifacts/qa with .png filenames.',
      'After any UI transition, refresh your understanding with snapshot or diff snapshot.',
      'Do not inspect repository source files, run git commands, or modify project code. The only allowed filesystem writes are QA artifacts such as screenshots and reports.',
      'Do not claim success without evidence from tool results.',
      'If a prerequisite is missing or the environment is broken, mark the relevant checks as blocked.',
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
          androidApplicationId: context.androidApplicationId,
          emulatorDevice: context.emulatorDevice,
          androidSerial: context.androidSerial,
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
      },
      write_report: {
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
      },
    },
  });

  const result = await agent.generate({
    prompt: buildPrompt(skills),
  });

  if (result.text) {
    console.log(trim(`Agent finished with final text:\n${result.text}`, 4000));
  }

  if (!existsSync(COMMENT_PATH)) {
    await persistReport({
      overallStatus: 'blocked',
      summary: result.text || 'The agent completed without calling write_report.',
      checked: ['Produce a QA report'],
      issues: ['The write_report tool was not called by the agent.'],
      nextSteps: [
        'Inspect the workflow logs and tighten the agent instructions.',
      ],
    });
    console.log(
      `Fallback QA report written to ${COMMENT_PATH} because write_report was not called.`,
    );
    return;
  }

  console.log(`QA report written to ${COMMENT_PATH}`);
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
