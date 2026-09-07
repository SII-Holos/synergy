import { Global } from "./global"
import { builtinCommands } from "./cli/commands"
import { installedPluginCliMetadata } from "./plugin/cli-metadata"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { Log } from "./util/log"
import { UI } from "./util/ui"
import { Installation } from "./global/installation"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { EOL } from "os"

import { parse as parseJsonc } from "jsonc-parser"
import { Flag } from "./flag/flag"
import { createPluginCliCommandModule } from "./plugin/cli-command"

async function flushCliOutput() {
  await Bun.sleep(25)
}

function printUnhandledFailure(kind: string, error: unknown) {
  const detail = error instanceof Error ? error.stack : String(error)
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
    if (informational) return
    if (!["send", "server"].includes(selectedCommand ?? "server")) await Global.initialize({ cache: false })
    let configLogLevel: string | undefined
    try {
      const { ConfigDomain } = await import("./config/domain")
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

const informational = process.argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
const requestedCommand = firstPositionalArg()
const selectedCommand = requestedCommand ?? (informational ? undefined : "server")
if (!informational && selectedCommand !== "send") await import("./product-registration")
for (const entry of builtinCommands) {
  const names = (Array.isArray(entry.command) ? entry.command : [entry.command]).map((name) => name.split(" ")[0])
  cli.command(
    names.includes(selectedCommand ?? "")
      ? await entry.load()
      : { command: entry.command, describe: entry.describe, handler() {} },
  )
}

const registered = new Set(
  builtinCommands.flatMap((entry) =>
    (Array.isArray(entry.command) ? entry.command : [entry.command]).map((name) => name.split(" ")[0]),
  ),
)
const directory = Flag.SYNERGY_CWD || process.cwd()
for (const plugin of await installedPluginCliMetadata()) {
  if (registered.has(plugin.id)) throw new Error(`Plugin CLI namespace ${plugin.id} conflicts with Synergy`)
  registered.add(plugin.id)
  cli.command(
    createPluginCliCommandModule({
      plugin,
      resolveScope: async () => (await (await import("./scope")).Scope.fromDirectory(directory)).scope,
    }),
  )
}

// Installed plugin commands are registered from generated manifest metadata.

cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      cli.showHelp("error")
    }
    throw err ?? new Error(msg || "Command failed")
  })
  .strict()

function firstPositionalArg() {
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--log-level") {
      index++
      continue
    }
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
  const { FormatError } = await import("./cli/error")
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e)
  }
  if (firstPositionalArg() === "send") {
    const { findRecordingError } = await import("./session/rollout/error")
    process.exitCode = findRecordingError(e) ? 5 : process.exitCode || 2
  } else process.exitCode = 1
} finally {
  if (!isLongRunningCommand()) {
    await flushCliOutput()
    process.exit()
  }
}
