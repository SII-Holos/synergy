import path from "node:path"
import { z } from "zod"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { OrganizationRecoveryAdministration } from "../backup/administration-recovery"
import { explicitOrganizationHome } from "./home"
import { withRecoveryOperation } from "./backup"

export const OrganizationRecoverCommand = cmd({
  command: "recover",
  describe:
    "explicitly recover an installed service-only Target and permanently retire its original Source; never Continue",
  builder: (yargs) =>
    yargs
      .option("input", {
        type: "string",
        demandOption: true,
        describe: "absolute original encrypted H0 archive directory",
      })
      .option("restore-id", {
        type: "string",
        demandOption: true,
        describe: "original held installation UUID; never creates another installation",
      })
      .option("key-file", {
        type: "string",
        demandOption: true,
        describe: "absolute private version-one recovery keys",
      })
      .option("source-home", {
        type: "string",
        demandOption: true,
        describe: "absolute original Source Home to verify and permanently fence",
      })
      .option("source-origin", {
        type: "string",
        describe: "original Source effective HTTPS origin when it has registered clients",
      })
      .option("work", {
        type: "string",
        demandOption: true,
        describe: "absolute independent private work directory; retain its fixed H1 and Reference for retries",
      })
      .option("origin", {
        type: "string",
        demandOption: true,
        describe: "exact HTTPS origin for the recovered service",
      })
      .check((args) => {
        explicitOrganizationHome()
        if ([args.input, args["key-file"], args["source-home"], args.work].some((value) => !path.isAbsolute(value)))
          throw new Error("Recovery file paths must be absolute")
        z.uuid().parse(args["restore-id"])
        for (const value of [args.origin, args["source-origin"]]) {
          if (!value) continue
          const origin = new URL(value)
          if (origin.protocol !== "https:" || origin.origin !== value)
            throw new Error("Recovery origins must be exact HTTPS origins")
        }
        return true
      }),
  async handler(args) {
    const home = explicitOrganizationHome()
    const { version: buildVersion } = z
      .object({ version: z.string().min(1).max(200) })
      .parse(await Bun.file(new URL("../../package.json", import.meta.url)).json())
    const result = await withRecoveryOperation(args["key-file"], (keys, signal) =>
      OrganizationRecoveryAdministration.recover({
        home,
        directory: args.input,
        restoreID: args["restore-id"],
        sourceHome: args["source-home"],
        work: args.work,
        publicOrigin: args.origin,
        sourceOrigin: args["source-origin"],
        buildVersion,
        keys,
        signal,
      }).catch((cause: unknown) => {
        throw new Error(
          "Recovery did not finish. Original Homes and recovery work are retained; retry with the same valid saved Reference and archives. Incomplete work remains blocked.",
          { cause },
        )
      }),
    )
    console.log(JSON.stringify(result))
  },
})
