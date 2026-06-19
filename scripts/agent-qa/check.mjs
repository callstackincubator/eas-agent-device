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

run("typecheck Eve agent", npmCommand, ["run", "typecheck"], { cwd: eveDir });
run("inspect Eve agent", npmCommand, ["exec", "--", "eve", "info", "--json"], {
  cwd: eveDir,
});
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
