import { runDispatcher } from "./dispatcher.js";
import { runPublisher } from "./publisher.js";

const execution = process.env.CODING_MODE === "publish" ? runPublisher : runDispatcher;

execution().catch((error) => {
  console.error(JSON.stringify({
    severity: "ERROR",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
