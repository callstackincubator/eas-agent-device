import { defineTool } from "eve/tools";
import { z } from "zod";

import { validateAndPersistReport } from "../lib/qa-runtime.js";

const resultStatusSchema = z.enum([
  "passed",
  "failed",
  "blocked",
  "not_tested",
  "unsure",
]);

export default defineTool({
  description:
    "Persist the final QA summary, findings, and screenshot index to artifacts/qa. Passed, failed, and unsure reports require at least one saved screenshot of a relevant app screen.",
  inputSchema: z.object({
    overallStatus: resultStatusSchema,
    summary: z.string(),
    checked: z.array(z.string()).optional(),
    issues: z.array(z.string()).optional(),
    nextSteps: z.array(z.string()).optional(),
    screenshotLabels: z
      .array(
        z.object({
          fileName: z
            .string()
            .describe("Saved screenshot file name, including .png."),
          label: z
            .string()
            .describe(
              "Very short route or state label for this screenshot, such as Home or Welcome screen.",
            ),
        }),
      )
      .optional(),
  }),
  execute: async (input) => validateAndPersistReport(input),
});
