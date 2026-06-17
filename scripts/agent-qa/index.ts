import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  BOOTSTRAP_ERROR,
  ROOT_DIR,
  SECTION_PATH,
  buildClientContext,
  ensureOutputDirs,
  ensureRequiredAgentQaEnvs,
  trim,
  writeBlockedReport,
} from "./eve/agent/lib/qa-runtime.js";

type EveClientModule = typeof import("./eve/node_modules/eve/dist/src/client/index.js");

const EVE_DIR = path.join(ROOT_DIR, "scripts", "agent-qa", "eve");
const EVE_PORT = Number(process.env.AGENT_QA_EVE_PORT || 4317);
const EVE_HOST = `http://127.0.0.1:${EVE_PORT}`;
const SERVER_READY_TIMEOUT_MS = Number(
  process.env.AGENT_QA_EVE_READY_TIMEOUT_MS || 60_000,
);
const EVE_PACKAGE_PATH = path.join(EVE_DIR, "node_modules", "eve", "package.json");

function buildServerEnv(): NodeJS.ProcessEnv {
  const rootBin = path.join(ROOT_DIR, "node_modules", ".bin");
  const eveBin = path.join(EVE_DIR, "node_modules", ".bin");

  return {
    ...process.env,
    AGENT_QA_ROOT_DIR: ROOT_DIR,
    PATH: [rootBin, eveBin, process.env.PATH || ""].filter(Boolean).join(":"),
  };
}

function resolveNpmCommand(): string {
  return process.env.AGENT_QA_NPM_BIN || process.env.npm_execpath || "npm";
}

function spawnNpm(args: string[]): ChildProcess {
  const child = spawn(resolveNpmCommand(), args, {
    cwd: EVE_DIR,
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

async function runNpm(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnNpm(args);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `npm ${args.join(" ")} failed (code ${code ?? "n/a"}, signal ${signal ?? "n/a"}).`,
        ),
      );
    });
  });
}

async function ensureEveDependencies(): Promise<void> {
  if (existsSync(EVE_PACKAGE_PATH)) {
    return;
  }

  console.log("Installing EVE agent dependencies...");
  await runNpm(["install"]);
}

function startEveServer(): ChildProcess {
  return spawnNpm([
    "exec",
    "--",
    "eve",
    "dev",
    "--no-ui",
    "--host",
    "127.0.0.1",
    "--port",
    String(EVE_PORT),
    "--logs",
    "stderr",
  ]);
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

async function stopEveServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 5_000);
    }),
  ]);
}

async function loadEveClient(): Promise<EveClientModule> {
  return import(
    pathToFileURL(path.join(EVE_DIR, "node_modules", "eve", "dist", "src", "client", "index.js")).href
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

  await ensureEveDependencies();

  const server = startEveServer();

  try {
    await waitForEveServer(server);
    const result = await runEveQa();

    if (result.message) {
      console.log(trim(`Eve agent finished with final text:\n${result.message}`, 4000));
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
