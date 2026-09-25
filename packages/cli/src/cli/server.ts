import {
  createManagedMigrationReporter,
  createManagedRecoveryReporter,
  createManagedStorageReporter,
  createManagedMaintenanceReporter,
} from "./managed-startup"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { withNetworkOptions, resolveNetworkOptions } from "@ericsanchezok/synergy-local-runtime/cli/network"
import type { RuntimeOptions } from "../server/runtime"
import { UI } from "@ericsanchezok/synergy-util/terminal"
import { FormatError, FormatUnknownError } from "@ericsanchezok/synergy-cli/cli/error"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "@ericsanchezok/synergy-harness/util/server-defaults"

export function createServerCommand(
  runServerRuntime: (options: Omit<RuntimeOptions, "runtimeFactory" | "status">) => Promise<unknown>,
) {
  return cmd({
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
      let network: Awaited<ReturnType<typeof resolveNetworkOptions>> | undefined
      try {
        const managed = process.env.SYNERGY_DESKTOP_STARTUP_PROGRESS === "1"
        const managedService = args.managedService

        await runServerRuntime({
          storageReporter: managed ? createManagedStorageReporter() : undefined,
          maintenanceReporter: managed ? createManagedMaintenanceReporter() : undefined,
          migrationReporter: managed ? createManagedMigrationReporter() : undefined,
          migrationOutput: managed ? "silent" : "interactive",
          recoveryReporter: managed ? createManagedRecoveryReporter() : undefined,
          interactive: !(managedService || args.nonInteractive),
          printBanner: args.banner,
          printChannelStatus: !managedService,
          network: async () => {
            network = await resolveNetworkOptions(args)
            return network
          },
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
          const healthUrl = displayUrl(network?.hostname ?? DEFAULT_SERVER_HOST, network?.port ?? DEFAULT_SERVER_PORT)
          const inspection = await ServerProcessLock.inspect(error.lock, { healthUrl }).catch(() => undefined)
          UI.error(`Another Synergy server process is already running (pid ${error.lock.pid})`)
          UI.println(`  Existing mode: ${error.lock.mode}`)
          UI.println(`  Existing cwd: ${error.lock.cwd}`)
          UI.println(`  Existing command: ${error.lock.command.join(" ")}`)
          UI.println(`  Lock file: ${ServerProcessLock.path()}`)
          if (inspection) {
            UI.println(
              `  PID state: alive=${inspection.alive} healthy=${inspection.healthy ?? "unknown"} ppid=${inspection.ppid ?? "?"} pgid=${inspection.pgid ?? "?"} cpu=${inspection.cpu ?? "?"}% elapsed=${inspection.elapsed ?? "?"}`,
            )
            if (inspection.listeningPorts?.length) {
              UI.println(`  Listening ports: ${inspection.listeningPorts.join(", ")}`)
            }
            if (inspection.command) UI.println(`  Process command: ${inspection.command}`)
            if (inspection.alive && inspection.healthy === false) {
              UI.println()
              UI.println("  The process is alive but did not respond to /global/health.")
            }
          }
          UI.println()
          UI.println("  Next:")
          UI.println("    Stop the other server process before running `synergy server`")
          UI.println("    If it is the managed background service, run `synergy stop`")
          UI.println(`    Otherwise run: kill ${error.lock.pid}`)
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
}

function displayUrl(hostname: string, port: number) {
  const displayHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "::1" : hostname
  const url = new URL("http://127.0.0.1")
  url.hostname = displayHost
  url.port = String(port)
  return url.toString().replace(/\/$/, "")
}
