import {
  HOOKS,
  HOOK_CATEGORIES,
  BUS_EVENT_NAMES,
  type HookCategory,
  type HookDescriptor,
} from "@ericsanchezok/synergy-plugin/hooks"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { PluginRuntimeCommand } from "./plugin-runtime"
import { PluginTestCommand } from "./plugin-test"
import { PluginPublishCommand } from "./plugin-publish"
import { PluginInfoCommand } from "./plugin-info"
import { PluginPermissionsCommand } from "./plugin-permissions"
import { PluginApproveCommand } from "./plugin-approve"
import { PluginBuildCommand } from "./plugin-build"
import { PluginPackCommand } from "./plugin-pack"
import { PluginValidateCommand } from "./plugin-validate"
import { PluginSignCommand } from "./plugin-sign"
import { PluginDevCommand } from "./plugin-dev"
import { PluginCreateCommand } from "./plugin-create"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Plugin } from "@/plugin"
import { PluginSpec } from "../../util/plugin-spec"

import type { Argv } from "yargs"
import { Config } from "../../config/config"
import { Instance } from "../../scope/instance"
import { Scope } from "@/scope"
import { EOL } from "os"
import path from "path"
import fs from "fs"
import * as prompts from "@clack/prompts"
import { read as readManifestFile } from "../../plugin/manifest-reader"
import { BunProc } from "../../util/bun"
import { findPackageRoot } from "../../plugin/loader"
import { diffPermissions } from "../../plugin/consent/diff"
import { baseCapabilities } from "../../plugin/capability"
import { computeRisk } from "../../plugin/consent/risk"
import { saveApproval, computeManifestHash, computePermissionsHash } from "../../plugin/consent/approval-store"
import * as Lockfile from "../../plugin/lockfile"
import { derivePluginSource } from "../../plugin/trust"
import { recordEvent } from "../../plugin/audit"
import type { PluginPermissionDiff } from "../../plugin/consent/schema"

// ---------------------------------------------------------------------------
// Helpers
function formatHookList(category?: HookCategory) {
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

// ---------------------------------------------------------------------------

async function readManifest(pluginDir: string): Promise<PluginManifest | null> {
  return readManifestFile(pluginDir)
}

function readPkgVersion(pluginDir: string): string | undefined {
  try {
    const pkgPath = path.join(pluginDir, "package.json")
    const raw = fs.readFileSync(pkgPath, "utf-8")
    const pkg = JSON.parse(raw)
    return pkg.version as string | undefined
  } catch {
    return undefined
  }
}

interface ContributedSummary {
  skills: number
  agents: number
  commands: number
  mcpServers: number
}

function getContributed(manifest: PluginManifest | null): ContributedSummary {
  return {
    skills: manifest?.contributes?.skills?.length ?? 0,
    agents: manifest?.contributes?.agents?.length ?? 0,
    commands: manifest?.contributes?.commands?.length ?? 0,
    mcpServers: manifest?.contributes?.mcp ? Object.keys(manifest.contributes.mcp).length : 0,
  }
}

function printContributed(manifest: PluginManifest | null) {
  const c = getContributed(manifest)
  const parts: string[] = []
  if (c.skills > 0) parts.push(`${c.skills} skill${c.skills !== 1 ? "s" : ""}`)
  if (c.agents > 0) parts.push(`${c.agents} agent${c.agents !== 1 ? "s" : ""}`)
  if (c.commands > 0) parts.push(`${c.commands} command${c.commands !== 1 ? "s" : ""}`)
  if (c.mcpServers > 0) parts.push(`${c.mcpServers} MCP server${c.mcpServers !== 1 ? "s" : ""}`)
  if (parts.length > 0) {
    UI.println(`  ${UI.Style.TEXT_DIM}Contributes:${UI.Style.TEXT_NORMAL} ${parts.join(", ")}`)
  }
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

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
      process.stdout.write(`Category: ${category.padEnd(12)}` + EOL + EOL)
    }

    formatHookList(category)
    process.stdout.write(
      UI.Style.TEXT_DIM +
        "Tip: use --json for structured output. See packages/plugin/README.md for authoring guidance." +
        UI.Style.TEXT_NORMAL +
        EOL,
    )
  },
})

// ---------------------------------------------------------------------------
// add <spec>
// ---------------------------------------------------------------------------

export const PluginAddCommand = cmd({
  command: "add <spec>",
  describe: "install and activate a plugin",
  builder: (yargs: Argv) =>
    yargs.positional("spec", {
      type: "string",
      describe: "plugin spec (e.g. my-plugin, github:org/repo, file://path/to/plugin)",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      async fn() {
        const spec = args.spec as string
        const spinner = prompts.spinner()
        spinner.start(`Adding plugin ${spec}`)

        try {
          const plugin = await Plugin.add(spec)
          const manifest = await Plugin.manifest(plugin.id)

          spinner.stop(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${plugin.name ?? plugin.id}`)
          UI.println(`  ${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL} ${plugin.id}`)

          const version = readPkgVersion(plugin.pluginDir)
          if (version) {
            UI.println(`  ${UI.Style.TEXT_DIM}Version:${UI.Style.TEXT_NORMAL} ${version}`)
          }

          printContributed(manifest)

          if (manifest?.description) {
            UI.println(`  ${UI.Style.TEXT_DIM}Description:${UI.Style.TEXT_NORMAL} ${manifest.description}`)
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          spinner.stop(`${UI.Style.TEXT_DANGER}✘${UI.Style.TEXT_NORMAL} ${spec}`)
          UI.error(message)
        }
      },
    })
  },
})

// ---------------------------------------------------------------------------
// remove <id>
// ---------------------------------------------------------------------------

export const PluginRemoveCommand = cmd({
  command: "remove <id>",
  describe: "uninstall and deactivate a plugin",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", {
        type: "string",
        describe: "plugin id to remove",
        demandOption: true,
      })
      .option("force", {
        type: "boolean",
        describe: "skip confirmation prompt",
        default: false,
      }),
  async handler(args) {
    await Instance.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      async fn() {
        const pluginId = args.id as string

        const plugin = await Plugin.get(pluginId)
        if (!plugin) {
          UI.error(`Plugin not found: ${pluginId}`)
          return
        }

        if (!args.force) {
          const confirmed = await prompts.confirm({
            message: `Remove plugin "${plugin.name ?? pluginId}"? This will uninstall and clean up all configuration.`,
          })
          if (confirmed !== true) {
            UI.println(UI.Style.TEXT_DIM + "Cancelled." + UI.Style.TEXT_NORMAL)
            return
          }
        }

        const spinner = prompts.spinner()
        spinner.start(`Removing plugin ${plugin.name ?? pluginId}`)

        try {
          await Plugin.remove(pluginId)
          spinner.stop(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Removed ${plugin.name ?? pluginId}`)
          UI.println(`${UI.Style.TEXT_DIM}Plugin uninstalled and configuration cleaned up.${UI.Style.TEXT_NORMAL}`)
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          spinner.stop(`${UI.Style.TEXT_DANGER}✘${UI.Style.TEXT_NORMAL} ${pluginId}`)
          UI.error(message)
        }
      },
    })
  },
})

// ---------------------------------------------------------------------------
// update [id]
// ---------------------------------------------------------------------------

export const PluginUpdateCommand = cmd({
  command: "update [id]",
  describe: "update plugins to their latest version",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", {
        type: "string",
        describe: "plugin id to update (omit to update all)",
      })
      .option("auto-approve", {
        type: "boolean",
        describe: "auto-approve permission changes without prompting (low-security convenience)",
        default: false,
      }),
  async handler(args) {
    await Instance.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      async fn() {
        const config = await Config.get()
        const configSpecs = config.plugin ?? []

        if (configSpecs.length === 0) {
          UI.println(UI.Style.TEXT_DIM + "No plugins configured." + UI.Style.TEXT_NORMAL)
          return
        }

        const autoApprove = args["auto-approve"] as boolean
        const isInteractive = interactive()

        // Determine which specs to update
        let specsToUpdate: { spec: string; id: string }[] = []

        if (args.id) {
          const targetId = args.id as string
          const targetPlugin = await Plugin.get(targetId)
          if (!targetPlugin) {
            UI.error(`Plugin not found: ${targetId}`)
            return
          }
          const matchedSpec = await findConfigSpec(targetPlugin.pluginDir, configSpecs)
          if (!matchedSpec) {
            UI.error(
              `Could not find config entry for plugin "${targetId}". Update the spec manually in 50-plugins.jsonc.`,
            )
            return
          }
          specsToUpdate.push({ spec: matchedSpec, id: targetId })
        } else {
          for (const spec of configSpecs) {
            const plugin = await Plugin.lookupSpec(spec)
            if (plugin) {
              specsToUpdate.push({ spec, id: plugin.id })
            }
          }
        }

        if (specsToUpdate.length === 0) {
          UI.println(UI.Style.TEXT_DIM + "No installed plugins to update." + UI.Style.TEXT_NORMAL)
          return
        }

        // Resolve new manifests and compute consent diffs
        let consented: { spec: string; id: string }[] = []

        for (const { spec, id } of specsToUpdate) {
          const oldPlugin = await Plugin.get(id)
          const oldManifest = oldPlugin ? await Plugin.manifest(id) : null

          // Fetch the new manifest
          const resolved = await resolveNewManifest(spec)
          const newManifest = resolved?.manifest ?? null

          if (!newManifest) {
            UI.error(`Could not resolve manifest for: ${spec}`)
            continue
          }

          // Compute permission diff
          const oldCaps = oldManifest ? baseCapabilities(oldManifest) : []
          const newCaps = baseCapabilities(newManifest)
          const diff = diffPermissions(id, oldManifest, newManifest, oldCaps, newCaps)

          if (!diff.requiresApproval) {
            consented.push({ spec, id })
            continue
          }

          printDiff(diff)

          if (autoApprove) {
            consented.push({ spec, id })
            continue
          }

          // Block in non-interactive mode
          if (!isInteractive) {
            UI.println(
              `${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} Permission changes require approval. Run interactively or use \`synergy plugin approve ${id}\`.${EOL}` +
                `  Use ${UI.Style.TEXT_DIM}--auto-approve${UI.Style.TEXT_NORMAL} to skip prompts (low-security convenience).`,
            )
            continue
          }

          // Prompt for approval
          const approved = await prompts.confirm({
            message: `Approve permission changes for ${SpecToDisplay(spec)}?`,
          })
          if (approved === true) {
            consented.push({ spec, id })
          } else {
            UI.println(UI.Style.TEXT_DIM + `Skipped ${SpecToDisplay(spec)}.${UI.Style.TEXT_NORMAL}`)
          }
        }

        if (consented.length === 0) {
          UI.println(UI.Style.TEXT_DIM + "No updates to apply." + UI.Style.TEXT_NORMAL)
          return
        }

        let succeeded = 0
        let failed = 0

        for (const { spec, id } of consented) {
          const spinner = prompts.spinner()
          spinner.start(`Updating ${SpecToDisplay(spec)}`)

          // Save backup of current lockfile entry for rollback
          let backupEntry: import("../../plugin/lockfile-schema").PluginLockEntry | null = null
          try {
            const { pkg } = PluginSpec.parse(spec)
            const currentLockfile = await Lockfile.read()
            backupEntry = currentLockfile.plugins[pkg] ?? null
          } catch {
            // No existing lockfile entry
          }

          let oldVersion: string | undefined
          let newVersion: string | undefined
          try {
            const plugin = await Plugin.get(id)
            oldVersion = plugin ? readPkgVersion(plugin.pluginDir) : undefined

            await Plugin.remove(id, { autoReload: false })
            await Plugin.add(spec, { autoReload: false })

            const updatedPlugin = await Plugin.get(id)
            newVersion = updatedPlugin ? readPkgVersion(updatedPlugin.pluginDir) : undefined

            // Write new approval record
            const updatedManifest = updatedPlugin ? await Plugin.manifest(id) : null
            if (updatedManifest) {
              const caps = baseCapabilities(updatedManifest)
              const source = updatedPlugin ? derivePluginSource(updatedPlugin.pluginDir) : "local"
              const risk = computeRisk(caps, updatedManifest)
              await saveApproval({
                pluginId: id,
                source,
                version: updatedManifest.version ?? "0.0.0",
                manifestHash: computeManifestHash(updatedManifest),
                permissionsHash: computePermissionsHash(updatedManifest, caps),
                approvedAt: Date.now(),
                approvedBy: "user",
                trustTier: "trusted-import",
                approvedCapabilities: caps,
                approvedNetworkDomains: updatedManifest.permissions?.network?.connectDomains ?? [],
                approvedUISurfaces: [],
                risk,
              })
            }

            const versionInfo =
              oldVersion && newVersion
                ? ` ${UI.Style.TEXT_DIM}(${oldVersion} → ${newVersion})${UI.Style.TEXT_NORMAL}`
                : ""

            spinner.stop(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${SpecToDisplay(spec)}${versionInfo}`)
            succeeded++
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            spinner.stop(`${UI.Style.TEXT_DANGER}✘${UI.Style.TEXT_NORMAL} ${SpecToDisplay(spec)}`)
            UI.println(`${UI.Style.TEXT_DIM}  ${message}${UI.Style.TEXT_NORMAL}`)

            // Rollback: restore old lockfile entry and re-install old version
            if (backupEntry) {
              try {
                const { pkg } = PluginSpec.parse(spec)
                const currentLockfile = await Lockfile.read()
                const restoredLockfile = Lockfile.addEntry(currentLockfile, pkg, backupEntry)
                await Lockfile.write(restoredLockfile)
                UI.println(
                  `  ${UI.Style.TEXT_WARNING}↩${UI.Style.TEXT_NORMAL} Rolled back lockfile for ${SpecToDisplay(spec)}`,
                )
              } catch {
                UI.println(
                  `  ${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} Could not roll back lockfile for ${SpecToDisplay(spec)}`,
                )
              }
            }

            // Record audit event for rollback
            void recordEvent({
              pluginId: id,
              type: "update_failed_rolled_back",
              details: {
                spec,
                oldVersion: oldVersion ?? "unknown",
                newVersion: newVersion ?? "unknown",
                error: message,
                rolledBack: backupEntry != null,
              },
            })
            failed++
          }
        }

        // Phase 2: reload once
        const spinner = prompts.spinner()
        spinner.start("Reloading plugins")
        await Plugin.reload()
        spinner.stop(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Plugins reloaded`)

        UI.println(
          `${UI.Style.TEXT_DIM}Updated ${succeeded} plugin${succeeded !== 1 ? "s" : ""}${failed > 0 ? `, ${failed} failed` : ""}${UI.Style.TEXT_NORMAL}`,
        )
      },
    })
  },
})

// ---------------------------------------------------------------------------
// list [--verbose] [--json]
// ---------------------------------------------------------------------------

export const PluginListCommand = cmd({
  command: "list",
  describe: "list installed plugins",
  builder: (yargs: Argv) =>
    yargs
      .option("verbose", {
        alias: "v",
        type: "boolean",
        describe: "show detailed plugin info (version, contributions, manifest)",
        default: false,
      })
      .option("json", {
        type: "boolean",
        describe: "output as JSON",
        default: false,
      }),
  async handler(args) {
    await Instance.provide({
      scope: (await Scope.fromDirectory(process.cwd())).scope,
      async fn() {
        const config = await Config.get()
        const configSpecs = config.plugin ?? []
        const loaded = await Plugin.getLoaded()
        if (args.json) {
          const result = []
          for (const p of loaded) {
            const m = await readManifest(p.pluginDir)
            const version = readPkgVersion(p.pluginDir)
            result.push({
              id: p.id,
              name: p.name,
              version: version ?? null,
              pluginDir: p.pluginDir,
              contributed: getContributed(m),
              manifest: m
                ? {
                    name: m.name,
                    version: m.version,
                    description: m.description,
                    author: m.author,
                    homepage: m.homepage,
                  }
                : null,
            })
          }
          process.stdout.write(JSON.stringify(result, null, 2) + EOL)
          return
        }

        if (configSpecs.length === 0) {
          UI.println(UI.Style.TEXT_DIM + "No plugins configured." + UI.Style.TEXT_NORMAL)
          return
        }

        for (const spec of configSpecs) {
          const plugin = await Plugin.lookupSpec(spec)
          const displayName = plugin?.name ?? plugin?.id ?? PluginSpec.displayName(spec)
          const installed = plugin != null
          const status = installed
            ? `${UI.Style.TEXT_SUCCESS}✔ loaded${UI.Style.TEXT_NORMAL}`
            : `${UI.Style.TEXT_DANGER}✘ not installed${UI.Style.TEXT_NORMAL}`

          UI.println(`${displayName.padEnd(36)} ${status}`)

          if (args.verbose && installed && plugin) {
            const version = readPkgVersion(plugin.pluginDir)
            if (version) {
              UI.println(`  ${UI.Style.TEXT_DIM}Version:${UI.Style.TEXT_NORMAL} ${version}`)
            }
            UI.println(`  ${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL} ${plugin.id}`)

            const manifest = await readManifest(plugin.pluginDir)
            if (manifest) {
              UI.println(`  ${UI.Style.TEXT_DIM}Manifest:${UI.Style.TEXT_NORMAL} ${manifest.name} v${manifest.version}`)
              if (manifest.description) {
                UI.println(`    ${manifest.description}`)
              }
            }
            printContributed(manifest)
          }
        }
      },
    })
  },
})

// ---------------------------------------------------------------------------
// search <query>
// ---------------------------------------------------------------------------

export const PluginSearchCommand = cmd({
  command: "search <query>",
  describe: "search the npm registry for Synergy plugins",
  builder: (yargs: Argv) =>
    yargs.positional("query", {
      type: "string",
      describe: "search query (keywords: synergy-plugin recommended)",
      demandOption: true,
    }),
  async handler(args) {
    const query = `synergy-plugin ${args.query as string}`
    const spinner = prompts.spinner()
    spinner.start(`Searching npm for "${query}"`)

    try {
      const proc = Bun.spawn(["bun", "x", "npm", "search", query, "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const code = await proc.exited
      if (code !== 0) {
        spinner.stop(`${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} npm search failed`)
        UI.println(`${UI.Style.TEXT_DIM}Search requires network access and the npm registry.${UI.Style.TEXT_NORMAL}`)
        return
      }

      const stdout = await Bun.readableStreamToText(proc.stdout!)
      let results: any[]
      try {
        results = JSON.parse(stdout)
      } catch {
        spinner.stop(`${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} Could not parse search results`)
        return
      }

      spinner.stop(
        `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Found ${results.length} result${results.length !== 1 ? "s" : ""}`,
      )
      process.stdout.write(EOL)

      const maxNameLen = Math.min(Math.max(...results.map((r: any) => String(r.name ?? "").length), 8), 40)
      const maxVerLen = Math.min(Math.max(...results.map((r: any) => String(r.version ?? "").length), 7), 12)

      for (const entry of results.slice(0, 20)) {
        const name = String(entry.name ?? "").padEnd(maxNameLen)
        const version = String(entry.version ?? "").padEnd(maxVerLen)
        const description = String(entry.description ?? "").slice(0, 72)
        process.stdout.write(
          `  ${UI.Style.TEXT_HIGHLIGHT}${name}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}${version}${UI.Style.TEXT_NORMAL} ${description}` +
            EOL,
        )
      }

      if (results.length > 20) {
        process.stdout.write(
          EOL +
            UI.Style.TEXT_DIM +
            `  ...and ${results.length - 20} more results. Refine your query for fewer results.` +
            UI.Style.TEXT_NORMAL +
            EOL,
        )
      }
    } catch {
      spinner.stop(`${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL} Search requires network access`)
      UI.println(
        `${UI.Style.TEXT_DIM}Could not reach the npm registry. Please check your network connection.${UI.Style.TEXT_NORMAL}`,
      )
    }
  },
})

// ---------------------------------------------------------------------------
// Helpers (dependency)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Consent gate helpers
// ---------------------------------------------------------------------------

function severityColor(severity: string): string {
  switch (severity) {
    case "high":
      return UI.Style.TEXT_DANGER
    case "medium":
      return UI.Style.TEXT_WARNING
    default:
      return UI.Style.TEXT_DIM
  }
}

function severityLabel(severity: string): string {
  return `${severityColor(severity)}${severity}${UI.Style.TEXT_NORMAL}`
}

function printDiff(diff: PluginPermissionDiff) {
  UI.println()
  UI.println(
    `${UI.Style.TEXT_NORMAL_BOLD}Permission changes:${UI.Style.TEXT_NORMAL} ${diff.fromVersion ?? "none"} → ${diff.toVersion}`,
  )

  if (diff.riskBefore || diff.riskAfter) {
    const before = diff.riskBefore ? severityLabel(diff.riskBefore) : "—"
    const after = diff.riskAfter ? severityLabel(diff.riskAfter) : "—"
    UI.println(`  ${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL} ${before} → ${after}`)
  }

  if (diff.added.length > 0) {
    UI.println(`  ${severityColor("high")}Added:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.added) {
      UI.println(
        `    ${severityLabel(item.severity)} ${item.title}${item.description ? ` — ${UI.Style.TEXT_DIM}${item.description}${UI.Style.TEXT_NORMAL}` : ""}`,
      )
    }
  }

  if (diff.removed.length > 0) {
    UI.println(`  ${severityColor("low")}Removed:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.removed) {
      UI.println(`    ${item.title}`)
    }
  }

  if (diff.unchanged.length > 0) {
    UI.println(`  ${UI.Style.TEXT_SUCCESS}Unchanged:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.unchanged) {
      UI.println(`    ${severityLabel(item.severity)} ${item.title}`)
    }
  }

  if (diff.changed.length > 0) {
    UI.println(`  ${UI.Style.TEXT_INFO}Changed severity:${UI.Style.TEXT_NORMAL}`)
    for (const c of diff.changed) {
      const before = severityLabel(c.before ?? "none")
      const after = severityLabel(c.after ?? "none")
      UI.println(`    ${c.key}: ${before} → ${after}`)
    }
  }

  UI.println()
}

/**
 * Resolve a new plugin manifest from a spec string by installing it to the
 * cache and reading plugin.json. Returns the manifest, the installed pluginDir,
 * and the resolved package/version.
 */
async function resolveNewManifest(spec: string): Promise<{
  manifest: PluginManifest | null
  pluginDir: string
  pkg: string
  version: string
} | null> {
  const { pkg, version } = PluginSpec.parse(spec)
  try {
    const result = await BunProc.install(pkg, version)
    const pluginDir = findPackageRoot(result.entryPath)
    const manifest = await readManifest(pluginDir)
    return { manifest, pluginDir, pkg, version }
  } catch {
    return null
  }
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}
function SpecToDisplay(spec: string): string {
  return PluginSpec.displayName(spec)
}

async function findConfigSpec(pluginDir: string, configSpecs: string[]): Promise<string | undefined> {
  for (const spec of configSpecs) {
    const plugin = await Plugin.lookupSpec(spec)
    if (plugin && plugin.pluginDir === pluginDir) return spec
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Top-level plugin command
// ---------------------------------------------------------------------------

export const PluginCommand = cmd({
  command: "plugin",
  describe: "install, remove, update, and inspect plugins",
  builder: (yargs: Argv) =>
    yargs
      .command(PluginHooksCommand)
      .command(PluginCreateCommand)
      .command(PluginAddCommand)
      .command(PluginRemoveCommand)
      .command(PluginUpdateCommand)
      .command(PluginBuildCommand)
      .command(PluginSignCommand)
      .command(PluginPackCommand)
      .command(PluginListCommand)
      .command(PluginSearchCommand)
      .command(PluginValidateCommand)
      .command(PluginDevCommand)
      .command(PluginRuntimeCommand)
      .command(PluginTestCommand)
      .command(PluginPublishCommand)
      .command(PluginInfoCommand)
      .command(PluginPermissionsCommand)
      .command(PluginApproveCommand)
      .demandCommand(),
  async handler() {},
})
