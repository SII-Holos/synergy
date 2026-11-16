import { z } from "zod"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { upgradeOrganizationServiceHome } from "../home-upgrade"
import { explicitOrganizationHome } from "./home"

export const OrganizationUpgradeCommand = cmd({
  command: "upgrade",
  describe:
    "explicitly advance an existing Service Home reader and release its native maintenance; print JSON metadata",
  builder: (yargs) =>
    yargs
      .option("request-id", {
        type: "string",
        demandOption: true,
        describe: "stable identifier for this exact Home upgrade and its retries",
      })
      .check((args) => {
        explicitOrganizationHome()
        z.string().min(1).max(128).parse(args["request-id"])
        return true
      }),
  async handler(args) {
    const controller = new AbortController()
    const stop = () => controller.abort(new Error("Organization Home upgrade cancelled"))
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      const receipt = await upgradeOrganizationServiceHome({
        home: explicitOrganizationHome(),
        requestID: args["request-id"],
        signal: controller.signal,
      })
      console.log(JSON.stringify(receipt))
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  },
})
