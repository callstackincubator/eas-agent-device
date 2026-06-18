import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { defineTool } from "eve/tools";
import { z } from "zod";

const execFile = promisify(execFileCallback);
const ROOT_DIR = path.resolve(process.env.AGENT_QA_ROOT_DIR || process.cwd());
const SCREENSHOTS_DIR =
  process.env.AGENT_QA_SCREENSHOTS_DIR ||
  path.join(tmpdir(), "agent-qa-screenshots");

function trim(value: string, max = 6000): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}\n...<truncated>`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default defineTool({
  description:
    "Run an agent-device command for mobile UI automation and screenshot capture. Use help workflow first and follow its current command guidance for interactions.",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "Exactly one agent-device subcommand, such as help, open, snapshot, press, fill, or screenshot. Put flags and arguments in args.",
      ),
    args: z
      .array(z.string())
      .default([])
      .describe(
        `Remaining CLI arguments. Use ["workflow"] for help workflow. Use ${SCREENSHOTS_DIR}/*.png for screenshots.`,
      ),
  }),
  execute: async ({ command, args }) => {
    const normalizedCommand = command.trim();
    const normalizedArgs =
      normalizedCommand === "help" && args.length === 0 ? ["workflow"] : args;
    const argv = [normalizedCommand, ...normalizedArgs];

    try {
      const result = await execFile("agent-device", argv, {
        cwd: ROOT_DIR,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      });

      return {
        ok: true,
        exitCode: 0,
        stdout: trim(result.stdout ?? "", 8000),
        stderr: trim(result.stderr ?? "", 4000),
        json: parseJson(result.stdout ?? ""),
      };
    } catch (unknownError) {
      const error = unknownError as Error & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };

      return {
        ok: false,
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: trim(error.stdout || "", 8000),
        stderr: trim(error.stderr || error.message, 4000),
        json: parseJson(error.stdout || ""),
      };
    }
  },
});
