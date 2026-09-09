import { Global } from "@ericsanchezok/synergy-harness/global"
import { coreCommands, type CommandEntry } from "./cli/commands"
import type { openLocalRuntime } from "@ericsanchezok/synergy-runtime-local"
import type { CommandModule } from "yargs"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { UI } from "./util/ui"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { EOL } from "os"

import { parse as parseJsonc } from "jsonc-parser"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"

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

export interface CliOptions {
  runtimeFactory: typeof openLocalRuntime
  commands?: CommandEntry[]
  dataCommands?(): Promise<CommandModule[]>
  defaultCommand?: string
  argv?: string[]
  beforeCommand?(command: string): Promise<void>
  pluginCommands?(directory: string): Promise<CommandModule[]>
}

export async function runCli(options: CliOptions): Promise<void> {
  try {
    await runCliImplementation(options)
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 1
  }
}

async function runCliImplementation(options: CliOptions): Promise<void> {
  const argv = options.argv ?? hideBin(process.argv)
  const builtinCommands = [...coreCommands(options.runtimeFactory, options.dataCommands), ...(options.commands ?? [])]
  const onRejection = (error: unknown) => {
    process.exitCode = 1
    Log.Default.error("rejection", { error: error instanceof Error ? error.message : error })
    printUnhandledFailure("Unhandled rejection", error)
  }
  const onException = (error: Error) => {
    process.exitCode = 1
    Log.Default.error("exception", { error: error.message })
    printUnhandledFailure("Uncaught exception", error)
  }

  const cli = yargs(argv)
    .exitProcess(false)
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
        const { ConfigDomain } = await import("@ericsanchezok/synergy-harness/config/domain")
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

  const informational =
    (argv.length === 0 && !options.defaultCommand) ||
    argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
  const requestedCommand = firstPositionalArg()
  const selectedCommand = requestedCommand ?? (informational ? undefined : options.defaultCommand)
  const hasCommand = builtinCommands.some((entry) =>
    (Array.isArray(entry.command) ? entry.command : [entry.command]).some(
      (name) => name.split(" ")[0] === selectedCommand,
    ),
  )
  if (!informational && selectedCommand && hasCommand) await options.beforeCommand?.(selectedCommand)
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
  for (const command of (await options.pluginCommands?.(directory)) ?? []) {
    const names = (Array.isArray(command.command) ? command.command : [command.command])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.split(" ")[0])
    for (const name of names) {
      if (registered.has(name)) throw new Error(`Plugin CLI namespace ${name} conflicts with Synergy`)
      registered.add(name)
    }
    cli.command(command)
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
      throw (
        err ??
        new Error(
          msg?.startsWith("Unknown argument") && requestedCommand
            ? `Command "${requestedCommand}" is unavailable in this installation.`
            : msg || "Command failed",
        )
      )
    })
    .strict()

  function firstPositionalArg() {
    const args = argv
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
    const command = firstPositionalArg() ?? options.defaultCommand
    if (command === "server") return true
    if (command === "logs") {
      return process.argv.includes("-f") || process.argv.includes("--follow")
    }
    return false
  }

  function isServerCommand() {
    return (firstPositionalArg() ?? options.defaultCommand) === "server"
  }

  process.on("unhandledRejection", onRejection)
  process.on("uncaughtException", onException)
  try {
    if (argv.length === 0 && !options.defaultCommand) cli.showHelp()
    else await cli.parse()
  } catch (e) {
    let data: Record<string, unknown> = {}
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
      const { findRecordingError } = await import("@ericsanchezok/synergy-harness/session/rollout/error")
      process.exitCode = findRecordingError(e) ? 5 : process.exitCode || 2
    } else process.exitCode = 1
  } finally {
    if (!isLongRunningCommand()) await flushCliOutput()
    process.removeListener("unhandledRejection", onRejection)
    process.removeListener("uncaughtException", onException)
  }
}
