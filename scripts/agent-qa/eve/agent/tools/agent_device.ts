import { defineTool } from "eve/tools";
import { z } from "zod";

import { runAgentDeviceCommand, SCREENSHOTS_DIR } from "../lib/qa-runtime.js";

export default defineTool({
  description:
    "Run an agent-device command for mobile UI automation and screenshot capture. Use help workflow first and follow its current command guidance for interactions.",
  inputSchema: z.object({
    command: z
      .string()
      .describe(
        "Exactly one agent-device subcommand, such as help, devices, reinstall, open, snapshot, press, fill, or screenshot. Do not include flags or arguments here; put them in args.",
      ),
    args: z
      .array(z.string())
      .default([])
      .describe(
        `Remaining CLI arguments. Use ["workflow"] for help workflow. Use ${SCREENSHOTS_DIR}/*.png for screenshots.`,
      ),
  }),
  execute: async ({ command, args }) => runAgentDeviceCommand(command, args),
});
