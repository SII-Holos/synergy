import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { run as runServerRuntime } from "../../server/runtime"

export const ServerCommand = cmd({
  command: ["$0", "server"],
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .option("managed-service", {
        type: "boolean",
        default: false,
        hidden: true,
      })
      .option("non-interactive", {
        type: "boolean",
        default: false,
        hidden: true,
      })
      .option("banner", {
        type: "boolean",
        default: true,
        hidden: true,
      }),
  describe: "start synergy server",
  handler: async (args) => {
    const network = await resolveNetworkOptions(args)
    const managedService = args.managedService

    await runServerRuntime({
      interactive: !(managedService || args.nonInteractive),
      printBanner: args.banner,
      printChannelStatus: !managedService,
      network,
    })
  },
})
