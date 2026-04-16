import {
  HOOKS,
  HOOK_CATEGORIES,
  BUS_EVENT_NAMES,
  type HookCategory,
  type HookDescriptor,
} from "@ericsanchezok/synergy-plugin/hooks"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { EOL } from "os"
import type { Argv } from "yargs"

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
      // Expand the event hook to show all observable bus event names
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

export const PluginCommand = cmd({
  command: "plugin",
  describe: "inspect plugin capabilities and metadata",
  builder: (yargs: Argv) => yargs.command(PluginHooksCommand).demandCommand(),
  async handler() {},
})
