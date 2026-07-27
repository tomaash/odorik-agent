import { migrateLegacyOdorik } from "./connectors/repository.js";

process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID?.trim()
  || "odorik-tx-260720-c58d";

const result = await migrateLegacyOdorik("explorers", "migration-cli");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
