import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

async function importEveInternal(modulePath) {
  return import(
    pathToFileURL(path.join(eveDir, "node_modules", "eve", modulePath)).href
  );
}

async function checkRuntimeGraph() {
  console.log("\n[agent-qa:check] resolve Eve runtime graph");

  const { createAuthoredSourceRuntimeCompiledArtifactsSource } =
    await importEveInternal(
      "dist/src/internal/application/runtime-compiled-artifacts-source.js",
    );
  const { loadCompiledManifest } = await importEveInternal(
    "dist/src/runtime/loaders/manifest.js",
  );
  const { loadCompiledModuleMapFromAuthoredSource } = await importEveInternal(
    "dist/src/internal/authored-module-map-loader.js",
  );
  const { resolveRuntimeAgentGraph } = await importEveInternal(
    "dist/src/runtime/resolve-agent-graph.js",
  );

  const compiledArtifactsSource =
    createAuthoredSourceRuntimeCompiledArtifactsSource(eveDir);
  const manifest = await loadCompiledManifest({ compiledArtifactsSource });
  const moduleMap = await loadCompiledModuleMapFromAuthoredSource({
    compiledArtifactsSource,
  });
  const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
  const tools = graph.root.toolRegistry.preparedTools
    .map((tool) => tool.name)
    .sort();
  const requiredTools = ["agent_device", "write_report"];
  const missingTools = requiredTools.filter((tool) => !tools.includes(tool));

  if (missingTools.length > 0) {
    throw new Error(
      `Missing Eve QA tools: ${missingTools.join(", ")}. Resolved tools: ${tools.join(", ") || "(none)"}.`,
    );
  }

  console.log(`[agent-qa:check] Eve tools include: ${requiredTools.join(", ")}`);
  console.log(`[agent-qa:check] Resolved tools: ${tools.join(", ")}`);
}

run("typecheck Eve agent", npmCommand, ["run", "typecheck"], { cwd: eveDir });
run("inspect Eve agent", npmCommand, ["exec", "--", "eve", "info", "--json"], {
  cwd: eveDir,
});
run("build Eve agent", npmCommand, ["exec", "--", "eve", "build"], {
  cwd: eveDir,
});
await checkRuntimeGraph();
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
