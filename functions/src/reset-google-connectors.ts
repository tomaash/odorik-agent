import { resetGoogleConnectorData } from "./connectors/repository.js";

process.env.GOOGLE_CLOUD_PROJECT ||= process.env.PROJECT_ID?.trim()
  || "odorik-tx-260720-c58d";

const args = new Set(process.argv.slice(2));
const companyArg = process.argv.slice(2).find((arg) => arg.startsWith("--company="));
const companyId = companyArg?.slice("--company=".length).trim() || "";
const apply = args.has("--apply");
const confirmArg = process.argv.slice(2).find((arg) => arg.startsWith("--confirm="));
const confirmation = confirmArg?.slice("--confirm=".length) || "";

if (!/^[a-zA-Z0-9_-]{1,100}$/.test(companyId)) {
  throw new Error("Pass a valid --company=<companyId>");
}
if (apply && confirmation !== `RESET_GOOGLE_${companyId}`) {
  throw new Error(
    `Applying the reset requires --confirm=RESET_GOOGLE_${companyId}`,
  );
}

const result = await resetGoogleConnectorData({
  companyId,
  actorUid: "reset-google-connectors-cli",
  apply,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!apply) {
  process.stdout.write(
    `Dry run only. Re-run with --apply --confirm=RESET_GOOGLE_${companyId} after reviewing counts.\n`,
  );
}
