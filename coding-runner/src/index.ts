import { runCodingJob } from "./runner.js";

try {
  await runCodingJob();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ severity: "ERROR", message })}\n`);
  process.exitCode = 1;
}
