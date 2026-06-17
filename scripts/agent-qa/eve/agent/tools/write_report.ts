import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";

const ROOT_DIR = path.resolve(process.env.AGENT_QA_ROOT_DIR || process.cwd());
const ARTIFACTS_DIR = path.join(ROOT_DIR, "artifacts", "qa");
const SCREENSHOTS_DIR = path.join(tmpdir(), "agent-qa-screenshots");
const REPORT_PATH = path.join(ARTIFACTS_DIR, "report.json");
const SECTION_PATH = path.join(ARTIFACTS_DIR, "section.md");
const STATUS_PATH = path.join(ARTIFACTS_DIR, "status.txt");
const MODEL_ID = process.env.QA_MODEL || "openai/gpt-5.4-mini";

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

const resultStatusSchema = z.enum([
  "passed",
  "failed",
  "blocked",
  "not_tested",
  "unsure",
]);

const reportSchema = z.object({
  overallStatus: resultStatusSchema,
  summary: z.string(),
  checked: z.array(z.string()).optional(),
  issues: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  screenshotLabels: z
    .array(
      z.object({
        fileName: z.string().describe("Saved screenshot file name, including .png."),
        label: z.string().describe("Very short route or state label."),
      }),
    )
    .optional(),
});

function normalizePlatform(value: string | undefined) {
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

async function uploadScreenshots(screenshots: ScreenshotInfo[]) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || screenshots.length === 0) {
    return screenshots;
  }

  const platform = normalizePlatform(process.env.QA_PLATFORM);
  const pr = parseJson<{ number?: number }>(process.env.PR_JSON, {});

  return Promise.all(
    screenshots.map(async (screenshot) => {
      try {
        const blob = await put(
          [
            "agent-qa",
            platform,
            pr.number ? `pr-${pr.number}` : "pr-unknown",
            process.env.BUILD_ID || "local-build",
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
    (screenshot) => `- ${screenshot.label || screenshot.fileName} (${screenshot.bytes} bytes)`,
  );
}

export default defineTool({
  description:
    "Persist the final QA summary, findings, and screenshot index to artifacts/qa.",
  inputSchema: reportSchema,
  execute: async (input) => {
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    const pr = parseJson<{ number?: number }>(process.env.PR_JSON, {});
    const platform = normalizePlatform(process.env.QA_PLATFORM);
    const platformLabel = platform === "ios" ? "iOS" : "Android";
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
      buildId: process.env.BUILD_ID || "",
      workflowUrl: process.env.WORKFLOW_URL || "",
      platform,
      platformLabel,
      prNumber: Number(pr.number || 0),
      screenshots,
      ...input,
    };
    const lines = [
      `### ${platformLabel}`,
      "",
      `**Status:** ${input.overallStatus}`,
      "",
      input.summary,
      "",
      "### Checked",
      ...(input.checked?.length ? input.checked.map((item) => `- ${item}`) : ["- No checks were recorded."]),
      "",
      "### Issues",
      ...(input.issues?.length ? input.issues.map((issue) => `- ${issue}`) : ["- No issues noted."]),
      "",
      "### Screenshots",
      ...renderScreenshotRows(screenshots),
      "",
      "### Next steps",
      ...(input.nextSteps?.length ? input.nextSteps.map((step) => `- ${step}`) : ["- No follow-up actions were suggested."]),
      "",
      "### Metadata",
      `- Build ID: \`${report.buildId || "n/a"}\``,
      `- Workflow: ${report.workflowUrl || "n/a"}`,
      "",
    ];

    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(SECTION_PATH, trim(lines.join("\n"), 16000), "utf8");
    await writeFile(STATUS_PATH, `${input.overallStatus}\n`, "utf8");

    return { ok: true };
  },
});
