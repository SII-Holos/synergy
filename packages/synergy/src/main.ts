import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { SendCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./global/installation"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { FormatError, FormatUnknownError } from "./cli/error"
import { ServerCommand } from "./cli/cmd/server"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { SessionCommand } from "./cli/cmd/session"
import { ChannelCommand } from "./cli/cmd/channel"
import { HolosCommand } from "./cli/cmd/holos"
import { ConfigCommand } from "./cli/cmd/config"
import { LibraryCommand } from "./cli/cmd/library"
import { EmbedCommand } from "./cli/cmd/embed"
import { StartCommand } from "./cli/cmd/start"
import { StopCommand } from "./cli/cmd/stop"
import { StatusCommand } from "./cli/cmd/status"
import { LogsCommand } from "./cli/cmd/logs"
import { DoctorCommand } from "./cli/cmd/doctor"
import { DiagnosticsCommand } from "./cli/cmd/diagnostics"

import { PluginCommand } from "./cli/cmd/plugin"
import { DataCommand, MigrateCommand } from "./cli/cmd/data"
import { MigrationCommand } from "./cli/cmd/migration"
import { ConfigDomain } from "./config/domain"
import { parse as parseJsonc } from "jsonc-parser"
import { Flag } from "./flag/flag"
import { Scope } from "./scope"
import { ScopeContext } from "./scope/context"
import { contributions, getLoadedPlugins } from "./plugin/loader"
import { createPluginCliCommandModule } from "./plugin/cli-command"

async function flushCliOutput() {
  await Bun.sleep(25)
}

function printUnhandledFailure(kind: string, error: unknown) {
  const detail = FormatUnknownError(error)
  const logfile = (() => {
    try {
      return Log.file()
    } catch {
      return undefined
    }
  })()
  const lines = [
    `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    detail,
    logfile ? `Check log file at ${logfile} for more details.` : undefined,
  ].filter(Boolean)
  console.error(lines.join(EOL))
}

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
  printUnhandledFailure("Unhandled rejection", e)
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
  printUnhandledFailure("Uncaught exception", e)
})

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("synergy")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    let configLogLevel: string | undefined
    try {
      const configText = await Bun.file(ConfigDomain.filepath("general"))
        .text()
        .catch(() => "")
      if (configText) {
        const config = parseJsonc(configText)
        if (config.logLevel && ["DEBUG", "INFO", "WARN", "ERROR"].includes(config.logLevel)) {
          configLogLevel = config.logLevel
        }
      }
    } catch {}

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal() && isServerCommand(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (process.env.LOG_LEVEL && ["DEBUG", "INFO", "WARN", "ERROR"].includes(process.env.LOG_LEVEL))
          return process.env.LOG_LEVEL as Log.Level
        if (configLogLevel) return configLogLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.SYNERGY = "1"

    Log.Default.info("synergy", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  .usage("\n" + UI.logo())
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(SendCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(AuthCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServerCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(SessionCommand)
  .command(ChannelCommand)
  .command(HolosCommand)
  .command(ConfigCommand)
  .command(LibraryCommand)
  .command(EmbedCommand)
  .command(StartCommand)
  .command(StopCommand)
  .command(StatusCommand)
  .command(LogsCommand)
  .command(DiagnosticsCommand)
  .command(PluginCommand)
  .command(DataCommand)
  .command(DoctorCommand)

  .command(MigrateCommand)
  .command(MigrationCommand)

type YargsCommandMetadata = {
  getInternalMethods(): {
    getCommandInstance(): { getCommands(): string[] }
  }
}

async function registerPluginCliCommands() {
  const directory = Flag.SYNERGY_CWD || process.cwd()
  const scope = (await Scope.fromDirectory(directory, { persist: false })).scope
  await ScopeContext.provide({
    scope,
    async fn() {
      const commandMetadata = cli as typeof cli & YargsCommandMetadata
      const registered = new Set(commandMetadata.getInternalMethods().getCommandInstance().getCommands())
      const plugins = [...(await getLoadedPlugins())].sort((left, right) => left.id.localeCompare(right.id))
      for (const plugin of plugins) {
        if (contributions(plugin, "cli.command").length === 0) continue
        if (registered.has(plugin.id)) throw new Error(`Plugin CLI namespace ${plugin.id} conflicts with Synergy`)
        registered.add(plugin.id)
        cli.command(
          createPluginCliCommandModule({
            plugin,
            resolveScope: async () => (await Scope.fromDirectory(directory)).scope,
          }),
        )
      }
    },
  })
}

await registerPluginCliCommands()

// Installed plugin commands are registered from generated manifest metadata.

cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      cli.showHelp("log")
    } else if (err) {
      console.error(err)
    } else if (msg) {
      console.error(msg)
    }
    process.exit(1)
  })
  .strict()

function firstPositionalArg() {
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("-")) return arg
  }
  return
}

function isLongRunningCommand() {
  const command = firstPositionalArg() ?? "server"
  if (command === "server") return true
  if (command === "logs") {
    return process.argv.includes("-f") || process.argv.includes("--follow")
  }
  return false
}

function isServerCommand() {
  return (firstPositionalArg() ?? "server") === "server"
}

try {
  await cli.parse()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e)
  }
  process.exitCode = 1
} finally {
  if (!isLongRunningCommand()) {
    await flushCliOutput()
    process.exit()
  }
}
