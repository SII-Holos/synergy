import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { run as runServerRuntime } from "../../server/runtime"
import { UI } from "../ui"
import { FormatError, FormatUnknownError } from "../error"
import { Log } from "../../util/log"
import { ServerProcessLock } from "../../daemon/server-process-lock"

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
    try {
      const network = await resolveNetworkOptions(args)
      const managedService = args.managedService

      await runServerRuntime({
        interactive: !(managedService || args.nonInteractive),
        printBanner: args.banner,
        printChannelStatus: !managedService,
        network,
      })
    } catch (error) {
      Log.Default.error("server startup failed", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
      })

      if (error instanceof ServerProcessLock.AlreadyRunningError) {
        UI.error(`Another Synergy server process is already running (pid ${error.lock.pid})`)
        UI.println(`  Existing mode: ${error.lock.mode}`)
        UI.println(`  Existing cwd: ${error.lock.cwd}`)
        UI.println(`  Existing command: ${error.lock.command.join(" ")}`)
        UI.println()
        UI.println("  Next:")
        UI.println("    Stop the other server process before running `synergy server`")
        UI.println("    If it is the managed background service, run `synergy stop`")
        UI.println("    Otherwise kill the process and retry")
        process.exitCode = 1
        return
      }

      const formatted = FormatError(error)
      if (formatted) {
        UI.error(formatted)
      } else {
        UI.error(`Server startup failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (process.argv.includes("--print-logs")) {
        console.error(FormatUnknownError(error))
      } else {
        UI.error(`Check log file at ${Log.file()} for more details, or rerun with --print-logs.`)
      }

      process.exitCode = 1
    }
  },
})
