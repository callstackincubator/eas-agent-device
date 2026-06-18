import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const eveDir = path.join(rootDir, "scripts", "agent-qa", "eve");
const npmCommand = process.env.AGENT_QA_NPM_BIN || "npm";

function run(label, command, args, options = {}) {
  console.log(`\n[agent-qa:check] ${label}`);

  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status ?? "n/a"}.`,
    );
  }
}

function capture(label, command, args, options = {}) {
  console.log(`\n[agent-qa:check] ${label}`);

  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status ?? "n/a"}.`,
    );
  }

  const stdout = result.stdout || "";
  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  return stdout;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("Eve info did not produce JSON output.");
    }

    return JSON.parse(output.slice(start, end + 1));
  }
}

function checkEveInfo(info) {
  const tools = (info.tools || [])
    .map((tool) => (typeof tool === "string" ? tool : tool.name))
    .sort();
  const requiredTools = ["agent_device", "write_report"];
  const missingTools = requiredTools.filter((tool) => !tools.includes(tool));

  if (missingTools.length > 0) {
    throw new Error(
      `Missing Eve QA tools: ${missingTools.join(", ")}. Resolved tools: ${tools.join(", ") || "(none)"}.`,
    );
  }

  console.log(`[agent-qa:check] Eve tools include: ${requiredTools.join(", ")}`);
  console.log(`[agent-qa:check] Authored tools: ${tools.join(", ")}`);
}

run("typecheck Eve agent", npmCommand, ["run", "typecheck"], { cwd: eveDir });
const eveInfoOutput = capture(
  "inspect Eve agent",
  npmCommand,
  ["exec", "--", "eve", "info", "--json"],
  { cwd: eveDir },
);
checkEveInfo(parseJsonOutput(eveInfoOutput));
run("build Eve agent", npmCommand, ["exec", "--", "eve", "build"], {
  cwd: eveDir,
});
run("exercise agent-qa bootstrap path", npmCommand, ["run", "agent-qa"], {
  env: {
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY || "local-validation",
    AGENT_QA_BOOTSTRAP_ERROR: "local validation probe",
    APPLICATION_ID: process.env.APPLICATION_ID || "dev.expo.easagentdevice",
    APP_PATH:
      process.env.APP_PATH ||
      path.join(rootDir, "artifacts", "agent-qa-local.app"),
    QA_PLATFORM: process.env.QA_PLATFORM || "android",
  },
});

console.log("\n[agent-qa:check] ok");
