import type { Argv } from "yargs"
import type {
  Plugin as PluginDescriptor,
  PluginCLIEntry,
  PluginCLICommand,
  PluginCLIGroup,
} from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { PluginSpec } from "../util/plugin-spec"
import { BunProc } from "../util/bun"
import { Global } from "../global"
import { Plugin } from "../plugin"
import { UI } from "./ui"
import { bootstrap } from "./bootstrap"
import { cmd } from "./cmd/cmd"
import path from "path"
import { existsSync } from "fs"
import { EOL } from "os"

// ---------------------------------------------------------------------------
// Discovery — lightweight, no Instance/scope dependency
// ---------------------------------------------------------------------------

interface DiscoveredPlugin {
  id: string
  name?: string
}

const BUILTIN_COMMANDS = new Set([
  "acp",
  "mcp",
  "send",
  "generate",
  "debug",
  "auth",
  "agent",
  "upgrade",
  "uninstall",
  "server",
  "web",
  "models",
  "stats",
  "export",
  "import",
  "session",
  "channel",
  "holos",
  "config",
  "identity",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "plugin",
  "data",
  "migrate",
  "completion",
])

/**
 * Resolve the package root directory for an installed plugin spec.
 * Returns undefined if the plugin is not installed.
 */
function resolveInstalledPath(spec: string): string | undefined {
  if (spec.startsWith("file://")) {
    const filePath = spec.slice("file://".length)
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
    return existsSync(absolute) ? absolute : undefined
  }

  const { pkg } = PluginSpec.parse(spec)
  const modDir = PluginSpec.isNonRegistry(spec) ? BunProc.resolvePkgName(pkg) : pkg
  const pkgRoot = path.join(Global.Path.cache, "node_modules", modDir)
  return existsSync(pkgRoot) ? pkgRoot : undefined
}

/**
 * Discover installed plugin descriptors from global config.
 * Uses Config.global() which reads the config file directly — no Instance scope needed.
 */
async function discoverPlugins(): Promise<DiscoveredPlugin[]> {
  let globalConfig: Config.Info
  try {
    globalConfig = await Config.global()
  } catch {
    return []
  }

  const specs = globalConfig.plugin ?? []
  const result: DiscoveredPlugin[] = []
  const seen = new Set<string>()

  for (const spec of specs) {
    try {
      const importTarget = resolveInstalledPath(spec)
      if (!importTarget) continue

      const mod = await import(importTarget)
      for (const exported of Object.values(mod)) {
        const desc = exported as PluginDescriptor
        if (!desc?.id || typeof desc?.init !== "function") continue
        if (seen.has(desc.id) || BUILTIN_COMMANDS.has(desc.id)) continue
        seen.add(desc.id)
        result.push({ id: desc.id, name: desc.name })
      }
    } catch {
      // Skip plugins that fail to resolve or import
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isGroup(entry: PluginCLIEntry): entry is PluginCLIGroup {
  return "subcommands" in entry
}

// ---------------------------------------------------------------------------
// Help output
// ---------------------------------------------------------------------------

function printPluginHelp(plugin: DiscoveredPlugin, commands: Record<string, PluginCLIEntry>) {
  const lines: string[] = [
    "",
    `${UI.Style.TEXT_NORMAL_BOLD}${plugin.name ?? plugin.id}${UI.Style.TEXT_NORMAL}`,
    "",
    "Commands:",
  ]

  for (const [name, entry] of Object.entries(commands)) {
    const desc = isGroup(entry) ? entry.description : entry.description
    lines.push(`  synergy ${plugin.id} ${name.padEnd(20)} ${desc}`)
    if (isGroup(entry)) {
      for (const [sub, subcmd] of Object.entries(entry.subcommands)) {
        lines.push(`    ${sub.padEnd(18)} ${subcmd.description}`)
      }
    }
  }

  process.stdout.write(lines.join(EOL) + EOL)
}

function printCommandHelp(plugin: DiscoveredPlugin, name: string, command: PluginCLICommand) {
  const lines = ["", `synergy ${plugin.id} ${name}`, "", command.description]

  const opts = command.options
  if (opts && Object.keys(opts).length > 0) {
    lines.push("", "Options:")
    for (const [key, def] of Object.entries(opts)) {
      const req = def.required ? " (required)" : ""
      lines.push(`  --${key.padEnd(20)} ${def.description ?? ""}${req}  [${def.type}]`)
    }
  }

  process.stdout.write(lines.join(EOL) + EOL)
}

// ---------------------------------------------------------------------------
// Command resolution and execution
// ---------------------------------------------------------------------------

function resolveEntry(
  commands: Record<string, PluginCLIEntry>,
  positionals: string[],
): { command?: PluginCLICommand; name: string } {
  const [first, second] = positionals
  if (!first) return { name: "" }

  const entry = commands[first]
  if (!entry) return { name: first }

  if (isGroup(entry)) {
    if (!second) return { name: first }
    return { command: entry.subcommands[second], name: `${first} ${second}` }
  }

  return { command: entry, name: first }
}

function coerceArgs(args: Record<string, any>, command: PluginCLICommand): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [key, val] of Object.entries(args)) {
    if (key === "_" || key === "$0" || key === "--") continue
    result[key] = val
  }

  // Coerce types based on option definitions
  if (command.options) {
    for (const [key, def] of Object.entries(command.options)) {
      if (result[key] === undefined) continue
      if (def.type === "number") result[key] = Number(result[key])
      else if (def.type === "boolean") result[key] = Boolean(result[key])
    }
  }

  return result
}

function validateRequired(args: Record<string, any>, command: PluginCLICommand): string | undefined {
  if (!command.options) return
  for (const [key, def] of Object.entries(command.options)) {
    if (def.required && args[key] === undefined) {
      return `Missing required option: --${key}`
    }
  }
}

// ---------------------------------------------------------------------------
// Yargs command factory
// ---------------------------------------------------------------------------

function createPluginCommand(plugin: DiscoveredPlugin) {
  return cmd({
    command: plugin.id,
    describe: plugin.name ?? `${plugin.id} plugin commands`,
    builder: (yargs: Argv) => yargs.strict(false).help(false),
    async handler(args) {
      await bootstrap(process.cwd(), async () => {
        const entries = await Plugin.cliEntries()
        const match = entries.find((e) => e.pluginId === plugin.id)
        if (!match || Object.keys(match.commands).length === 0) {
          UI.error(`Plugin "${plugin.id}" has no CLI commands.`)
          process.exitCode = 1
          return
        }

        const positionals = (args._ as string[]).filter((a) => a !== plugin.id)
        const wantsHelp = args.help === true || args.h === true

        if (positionals.length === 0 && !wantsHelp) {
          printPluginHelp(plugin, match.commands)
          return
        }

        if (positionals.length === 0 && wantsHelp) {
          printPluginHelp(plugin, match.commands)
          return
        }

        const resolved = resolveEntry(match.commands, positionals)

        if (!resolved.command) {
          if (!wantsHelp) {
            UI.error(`Unknown command: synergy ${plugin.id} ${positionals.join(" ")}`)
          }
          printPluginHelp(plugin, match.commands)
          if (!wantsHelp) process.exitCode = 1
          return
        }

        if (wantsHelp) {
          printCommandHelp(plugin, resolved.name, resolved.command)
          return
        }

        const cleanArgs = coerceArgs(args, resolved.command)
        const validationError = validateRequired(cleanArgs, resolved.command)
        if (validationError) {
          UI.error(validationError)
          printCommandHelp(plugin, resolved.name, resolved.command)
          process.exitCode = 1
          return
        }

        const result = await resolved.command.execute(cleanArgs)
        if (result) UI.println(result)
      })
    },
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover installed plugins and register their CLI commands with yargs.
 * Called before cli.parse() in the main entry point.
 */
export async function registerPluginCommands(cli: Argv) {
  const plugins = await discoverPlugins()
  for (const plugin of plugins) {
    cli.command(createPluginCommand(plugin))
  }
}
