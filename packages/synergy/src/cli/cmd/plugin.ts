import {
  HOOKS,
  HOOK_CATEGORIES,
  BUS_EVENT_NAMES,
  type HookCategory,
  type HookDescriptor,
} from "@ericsanchezok/synergy-plugin/hooks"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { BunProc } from "../../util/bun"
import { PluginSpec } from "../../util/plugin-spec"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { EOL } from "os"
import path from "path"
import { existsSync } from "fs"
import * as prompts from "@clack/prompts"
import type { Argv } from "yargs"

function isPluginInstalled(pkg: string): boolean {
  const modDir = PluginSpec.isNonRegistry(pkg) ? BunProc.resolvePkgName(pkg) : pkg
  return existsSync(path.join(Global.Path.cache, "node_modules", modDir))
}

function formatCategory(category: HookCategory) {
  return category.padEnd(12)
}

function printHookList(category?: HookCategory) {
  const hooks = category ? HOOKS.filter((hook: HookDescriptor) => hook.category === category) : HOOKS
  const grouped = category
    ? [[category, hooks] as const]
    : HOOK_CATEGORIES.map(
        (name: HookCategory) => [name, hooks.filter((hook: HookDescriptor) => hook.category === name)] as const,
      )

  for (const [groupName, groupHooks] of grouped) {
    if (groupHooks.length === 0) continue
    process.stdout.write(UI.Style.TEXT_HIGHLIGHT_BOLD + groupName + UI.Style.TEXT_NORMAL + EOL)
    for (const hook of groupHooks) {
      const mutates = hook.mutatesOutput ? "mutates" : "observe"
      process.stdout.write(`  ${hook.name.padEnd(38)} ${mutates.padEnd(8)} ${hook.summary}` + EOL)
      if (hook.name === "event") {
        for (const eventName of BUS_EVENT_NAMES) {
          process.stdout.write(`    ${eventName}` + EOL)
        }
      }
    }
    process.stdout.write(EOL)
  }
}

export const PluginHooksCommand = cmd({
  command: "hooks",
  describe: "list all supported plugin hooks",
  builder: (yargs: Argv) =>
    yargs
      .option("json", {
        type: "boolean",
        describe: "print hooks as JSON",
      })
      .option("category", {
        type: "string",
        describe: "filter hooks by category",
        choices: HOOK_CATEGORIES,
      }),
  async handler(args) {
    const category = args.category as HookCategory | undefined
    const hooks = category ? HOOKS.filter((hook: HookDescriptor) => hook.category === category) : HOOKS

    if (args.json) {
      const hooksWithEvents = hooks.map((hook) =>
        hook.name === "event" ? { ...hook, eventNames: BUS_EVENT_NAMES } : hook,
      )
      process.stdout.write(JSON.stringify(hooksWithEvents, null, 2) + EOL)
      return
    }

    UI.empty()
    process.stdout.write(UI.logo() + EOL + EOL)
    process.stdout.write(UI.Style.TEXT_NORMAL_BOLD + "Plugin Hooks" + UI.Style.TEXT_NORMAL + EOL)
    process.stdout.write("Current formal plugin hook surface for Synergy." + EOL + EOL)

    if (category) {
      process.stdout.write(`Category: ${formatCategory(category)}` + EOL + EOL)
    }

    printHookList(category)
    process.stdout.write(
      UI.Style.TEXT_DIM +
        "Tip: use --json for structured output. See packages/plugin/README.md for authoring guidance." +
        UI.Style.TEXT_NORMAL +
        EOL,
    )
  },
})

export const PluginUpdateCommand = cmd({
  command: "update [plugin]",
  describe: "re-install plugins to get the latest version",
  builder: (yargs: Argv) =>
    yargs.positional("plugin", {
      type: "string",
      describe: "specific plugin spec to update (e.g. github:SII-Holos/holos-inspire)",
    }),
  async handler(args) {
    const config = await Config.get()
    const plugins = config.plugin ?? []

    if (plugins.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No plugins configured." + UI.Style.TEXT_NORMAL)
      return
    }

    const toUpdate = args.plugin ? [args.plugin as string] : plugins

    if (args.plugin && !plugins.includes(args.plugin as string)) {
      UI.error(`Plugin "${args.plugin}" is not in your configuration.`)
      return
    }

    let succeeded = 0
    let failed = 0

    for (const pluginSpec of toUpdate) {
      const { pkg, version } = PluginSpec.parse(pluginSpec)
      const spinner = prompts.spinner()
      spinner.start(`Updating ${pluginSpec}`)

      try {
        await BunProc.invalidateCache(pkg)
        await BunProc.install(pkg, version)
        spinner.stop(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${pluginSpec}`)
        succeeded++
      } catch {
        spinner.stop(`${UI.Style.TEXT_DANGER}✘${UI.Style.TEXT_NORMAL} ${pluginSpec}`)
        failed++
      }
    }

    UI.println(
      `${UI.Style.TEXT_DIM}Updated ${succeeded} plugin${succeeded !== 1 ? "s" : ""}${failed > 0 ? `, ${failed} failed` : ""}${UI.Style.TEXT_NORMAL}`,
    )
  },
})

export const PluginListCommand = cmd({
  command: "list",
  describe: "list configured plugins and their install status",
  builder: (yargs: Argv) => yargs,
  async handler() {
    const config = await Config.get()
    const plugins = config.plugin ?? []

    if (plugins.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No plugins configured." + UI.Style.TEXT_NORMAL)
      return
    }

    for (const pluginSpec of plugins) {
      const { pkg } = PluginSpec.parse(pluginSpec)
      const installed = isPluginInstalled(pkg)
      const status = installed
        ? `${UI.Style.TEXT_SUCCESS}✔ installed${UI.Style.TEXT_NORMAL}`
        : `${UI.Style.TEXT_DANGER}✘ not installed${UI.Style.TEXT_NORMAL}`
      UI.println(`${pluginSpec.padEnd(36)} ${status}`)
    }
  },
})

export const PluginCommand = cmd({
  command: "plugin",
  describe: "inspect plugin capabilities and metadata",
  builder: (yargs: Argv) =>
    yargs.command(PluginHooksCommand).command(PluginUpdateCommand).command(PluginListCommand).demandCommand(),
  async handler() {},
})
