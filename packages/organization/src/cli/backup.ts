import path from "node:path"
import { z } from "zod"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { OrganizationBackupAdministration } from "../backup/administration"
import { explicitOrganizationHome } from "./home"
import { withRecoveryKeys } from "./recovery-key"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"

function absoluteFiles(...files: string[]) {
  explicitOrganizationHome()
  if (files.some((file) => !path.isAbsolute(file))) throw new Error("Recovery file paths must be absolute")
  return true
}
export async function withRecoveryOperation<T>(
  keyFile: string,
  body: (keys: VaultKeyProvider, signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error("Organization recovery command cancelled"))
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    return await withRecoveryKeys(keyFile, (keys) => body(keys, controller.signal))
  } finally {
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}
export const OrganizationBackupCommand = cmd({
  command: "backup",
  describe: "capture an encrypted native namespace cohort in a new directory; print verified JSON metadata",
  builder: (yargs) =>
    yargs
      .option("output", { type: "string", demandOption: true, describe: "absolute new encrypted archive directory" })
      .option("key-file", {
        type: "string",
        demandOption: true,
        describe: "absolute private version-one recovery key file",
      })
      .option("origin", {
        type: "string",
        describe: "exact public HTTPS origin when the service has registered clients",
      })
      .check((args) => {
        absoluteFiles(args.output, args["key-file"])
        if (args.origin) {
          const origin = new URL(args.origin)
          if (origin.protocol !== "https:" || origin.origin !== args.origin)
            throw new Error("Backup origin must be an exact HTTPS origin")
        }
        return true
      }),
  async handler(args) {
    const home = explicitOrganizationHome()
    const { version: buildVersion } = z
      .object({ version: z.string().min(1).max(200) })
      .parse(await Bun.file(new URL("../../package.json", import.meta.url)).json())
    const result = await withRecoveryOperation(args["key-file"], (keys, signal) =>
      OrganizationBackupAdministration.capture({
        home,
        directory: args.output,
        buildVersion,
        keys,
        publicOrigin: args.origin,
        signal,
      }),
    )
    console.log(JSON.stringify(result))
  },
})
export const OrganizationRestoreCommand = cmd({
  command: "restore",
  describe: "verify and install archived service bytes into an independent recovery-held Home; never enable execution",
  builder: (yargs) =>
    yargs
      .option("input", { type: "string", demandOption: true, describe: "absolute encrypted archive directory" })
      .option("key-file", {
        type: "string",
        demandOption: true,
        describe: "absolute private version-one recovery key file",
      })
      .option("restore-id", {
        type: "string",
        demandOption: true,
        describe: "stable UUID for this exact restoration and its retries",
      })
      .check((args) => {
        absoluteFiles(args.input, args["key-file"])
        z.uuid().parse(args["restore-id"])
        return true
      }),
  async handler(args) {
    const home = explicitOrganizationHome()
    const result = await withRecoveryOperation(args["key-file"], (keys, signal) =>
      OrganizationBackupAdministration.install({
        home,
        directory: args.input,
        restoreID: args["restore-id"],
        keys,
        signal,
      }),
    )
    console.log(JSON.stringify(result))
  },
})
