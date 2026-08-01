import { runAuthWorker } from "./worker.js";

runAuthWorker().catch((error) => {
  console.error("Grok subscription authorization worker failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
