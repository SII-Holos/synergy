import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { PluginRuntimeCommand } from "./plugin-runtime"
import { PluginTestCommand } from "./plugin-test"
import { PluginPublishMarketCommand } from "./plugin-publish-market"
import { PluginEntryCommand } from "./plugin-entry"
import { PluginInfoCommand } from "./plugin-info"
import { PluginPermissionsCommand } from "./plugin-permissions"
import { PluginApproveCommand } from "./plugin-approve"
import { PluginBuildCommand } from "./plugin-build"
import { PluginPackCommand } from "./plugin-pack"
import { PluginValidateCommand } from "./plugin-validate"
import { PluginSignCommand } from "./plugin-sign"
import { PluginDevCommand } from "./plugin-dev"
import { PluginCreateCommand } from "./plugin-create"
import { pluginCliRequestTimeoutMs } from "./plugin-server"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Plugin } from "@/plugin"
import { PluginSpec } from "../../util/plugin-spec"

import type { Argv } from "yargs"
import { Config } from "../../config/config"
import { ScopeContext } from "../../scope/context"
import { Scope } from "@/scope"
import { EOL } from "os"
import path from "path"
import fs from "fs"
import * as prompts from "@clack/prompts"
import { readPluginManifest } from "../../plugin/spec-resolver"
import { diffPermissions } from "../../plugin/consent/diff"
import { baseCapabilities } from "../../plugin/capability"
import { Server } from "../../server/server"
import { isServerReachable } from "../network"
import { resolvePluginSpec } from "../../plugin/spec-resolver"
import { doctor as runPluginDoctor } from "../../plugin/doctor"
import type { PluginPermissionDiff } from "../../plugin/consent/schema"

async function readManifest(pluginDir: string): Promise<PluginManifest> {
  return readPluginManifest(pluginDir)
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
  operations: number
  mcpServers: number
}

function getContributed(manifest: PluginManifest): ContributedSummary {
  return {
    skills: manifest.contributions.filter((item) => item.kind === "skill").length,
    agents: manifest.contributions.filter((item) => item.kind === "agent").length,
    operations: manifest.contributions.filter((item) => item.kind === "operation").length,
    mcpServers: manifest.contributions.filter((item) => item.kind === "mcp").length,
  }
}

function printContributed(manifest: PluginManifest) {
  const c = getContributed(manifest)
  const parts: string[] = []
  if (c.skills > 0) parts.push(`${c.skills} skill${c.skills !== 1 ? "s" : ""}`)
  if (c.agents > 0) parts.push(`${c.agents} agent${c.agents !== 1 ? "s" : ""}`)
  if (c.operations > 0) parts.push(`${c.operations} operation${c.operations !== 1 ? "s" : ""}`)
  if (c.mcpServers > 0) parts.push(`${c.mcpServers} MCP server${c.mcpServers !== 1 ? "s" : ""}`)
  if (parts.length > 0) {
    UI.println(`  ${UI.Style.TEXT_DIM}Contributes:${UI.Style.TEXT_NORMAL} ${parts.join(", ")}`)
  }
}

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
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const spec = args.spec as string
        const spinner = prompts.spinner()
        spinner.start(`Adding plugin ${spec}`)

        try {
          const plugin = await Plugin.add(spec)
          const manifest = await Plugin.manifest(plugin.id)
          if (!manifest) throw new Error(`Plugin manifest not found: ${plugin.id}`)

          spinner.stop(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${plugin.name ?? plugin.id}`)
          UI.println(`  ${UI.Style.TEXT_DIM}ID:${UI.Style.TEXT_NORMAL} ${plugin.id}`)

          const version = readPkgVersion(plugin.pluginDir)
          if (version) {
            UI.println(`  ${UI.Style.TEXT_DIM}Version:${UI.Style.TEXT_NORMAL} ${version}`)
          }

          printContributed(manifest)

          if (manifest.description) {
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
    await ScopeContext.provide({
      scope: Scope.home(),
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
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const config = await Config.globalResolved()
        const configSpecs = config.plugin ?? []

        if (configSpecs.length === 0) {
          UI.println(UI.Style.TEXT_DIM + "No plugins configured." + UI.Style.TEXT_NORMAL)
          return
        }

        const autoApprove = args["auto-approve"] as boolean
        const isInteractive = interactive()

        // Determine which specs to update
        let specsToUpdate: ConfiguredPluginPackage[] = []
        const configuredPlugins = await Promise.all(configSpecs.map(readConfiguredPluginPackage))

        if (args.id) {
          const targetId = args.id as string
          const targetPlugin = configuredPlugins.find((plugin) => pluginMatches(plugin, targetId))
          if (!targetPlugin) {
            UI.error(`Plugin not found: ${targetId}`)
            return
          }
          specsToUpdate.push(targetPlugin)
        } else {
          specsToUpdate = configuredPlugins
        }

        if (specsToUpdate.length === 0) {
          UI.println(UI.Style.TEXT_DIM + "No configured plugins to update." + UI.Style.TEXT_NORMAL)
          return
        }

        // Resolve new manifests and compute consent diffs
        let consented: Array<{ current: ConfiguredPluginPackage; resolved: ResolvedPluginPackage }> = []

        for (const current of specsToUpdate) {
          const { spec, id } = current
          const oldManifest = current.manifest
          const resolved = await resolveNewManifest(spec, { refresh: true })

          if (!resolved?.manifest) {
            UI.error(`Could not resolve manifest for: ${spec}`)
            continue
          }
          const newManifest = resolved.manifest

          // Compute permission diff
          const oldCaps = oldManifest ? baseCapabilities(oldManifest) : []
          const newCaps = baseCapabilities(newManifest)
          const diff = diffPermissions(id, oldManifest, newManifest, oldCaps, newCaps)

          if (!diff.requiresApproval) {
            consented.push({ current, resolved })
            continue
          }

          printDiff(diff)

          if (autoApprove) {
            consented.push({ current, resolved })
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
            consented.push({ current, resolved })
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

        for (const { current, resolved } of consented) {
          const { spec, id } = current
          const spinner = prompts.spinner()
          spinner.start(`Updating ${SpecToDisplay(spec)}`)

          let oldVersion: string | undefined
          let newVersion: string | undefined
          try {
            oldVersion = current.installedVersion
            newVersion = resolved.manifest.version ?? readPkgVersion(resolved.pluginDir)
            await Plugin.add(spec, { skipConsent: true })

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
            failed++
          }
        }

        if (succeeded > 0) {
          await notifyServerPluginReload()
        }

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
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const config = await Config.current()
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
// doctor [--fix]
// ---------------------------------------------------------------------------

export const PluginDoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose plugin config, lockfile, and cache drift",
  builder: (yargs: Argv) =>
    yargs
      .option("fix", {
        type: "boolean",
        describe: "repair duplicate config specs, stale lock entries, and orphan archive caches",
        default: false,
      })
      .option("json", {
        type: "boolean",
        describe: "output machine-readable JSON",
        default: false,
      }),
  async handler(args) {
    await ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const result = await runPluginDoctor({ fix: args.fix as boolean })
        if (args.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + EOL)
          return
        }

        if (result.issues.length === 0) {
          UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Plugin installation state is clean.`)
          return
        }

        for (const issue of result.issues) {
          const marker =
            issue.fixed === true
              ? `${UI.Style.TEXT_SUCCESS}fixed${UI.Style.TEXT_NORMAL}`
              : issue.fixed === false
                ? `${UI.Style.TEXT_WARNING}manual${UI.Style.TEXT_NORMAL}`
                : `${UI.Style.TEXT_DIM}found${UI.Style.TEXT_NORMAL}`
          UI.println(`  ${marker} ${issue.message}`)
        }

        if (!args.fix) {
          UI.println(
            `${UI.Style.TEXT_DIM}Run ${UI.Style.TEXT_NORMAL}synergy plugin doctor --fix${UI.Style.TEXT_DIM} to repair safe drift automatically.${UI.Style.TEXT_NORMAL}`,
          )
        } else if (result.changed) {
          UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Plugin installation state repaired.`)
        } else {
          UI.println(`${UI.Style.TEXT_DIM}No automatic repairs were needed.${UI.Style.TEXT_NORMAL}`)
        }
      },
    })
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
interface ConfiguredPluginPackage {
  spec: string
  id: string
  pkg: string
  version: string
  pluginDir: string
  manifest: PluginManifest
  installedVersion?: string
}

interface ResolvedPluginPackage {
  manifest: PluginManifest
  pluginDir: string
  pkg: string
  version: string
  entryPath?: string
}

async function readConfiguredPluginPackage(spec: string): Promise<ConfiguredPluginPackage> {
  const resolved = await resolvePluginSpec(spec, {
    install: false,
    refresh: false,
  })
  const pluginDir = resolved.pluginDir
  const manifest = resolved.manifest
  return {
    spec,
    pkg: resolved.pkg,
    version: resolved.version,
    pluginDir,
    manifest,
    id: manifest.id,
    installedVersion: readPkgVersion(pluginDir),
  }
}

function pluginMatches(plugin: ConfiguredPluginPackage, target: string): boolean {
  return (
    plugin.id === target ||
    plugin.pkg === target ||
    plugin.manifest.name === target ||
    PluginSpec.displayName(plugin.spec) === target
  )
}

async function resolveNewManifest(
  spec: string,
  options: { refresh?: boolean } = {},
): Promise<ResolvedPluginPackage | null> {
  try {
    const resolved = await resolvePluginSpec(spec, {
      install: !spec.startsWith("file://"),
      refresh: options.refresh && !spec.startsWith("file://"),
    })
    return {
      manifest: resolved.manifest,
      pluginDir: resolved.pluginDir,
      pkg: resolved.pkg,
      version: resolved.version,
      entryPath: resolved.entryPath,
    }
  } catch {
    return null
  }
}

async function notifyServerPluginReload() {
  if (!(await isServerReachable(Server.DEFAULT_URL))) {
    UI.println(
      UI.Style.TEXT_DIM + "Plugins updated. Start or reload the server to activate them." + UI.Style.TEXT_NORMAL,
    )
    return
  }

  const response = await fetch(`${Server.DEFAULT_URL}/runtime/reload`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      targets: ["plugin"],
      scope: "global",
      reason: "plugin update",
    }),
    signal: AbortSignal.timeout(await pluginCliRequestTimeoutMs()),
  }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }) as Response)

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    UI.println(
      UI.Style.TEXT_WARNING +
        `Plugin packages updated, but runtime reload failed${response.status ? ` (${response.status})` : ""}.` +
        UI.Style.TEXT_NORMAL,
    )
    if (text) UI.println(UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL)
    return
  }

  UI.println(`${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} Server plugin runtime reloaded`)
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}
function SpecToDisplay(spec: string): string {
  return PluginSpec.displayName(spec)
}

// ---------------------------------------------------------------------------
// Top-level plugin command
// ---------------------------------------------------------------------------

export const PluginCommand = cmd({
  command: "plugin",
  describe: "install, remove, update, and inspect plugins",
  builder: (yargs: Argv) =>
    yargs
      .command(PluginCreateCommand)
      .command(PluginAddCommand)
      .command(PluginRemoveCommand)
      .command(PluginUpdateCommand)
      .command(PluginBuildCommand)
      .command(PluginSignCommand)
      .command(PluginPackCommand)
      .command(PluginListCommand)
      .command(PluginSearchCommand)
      .command(PluginDoctorCommand)
      .command(PluginValidateCommand)
      .command(PluginDevCommand)
      .command(PluginRuntimeCommand)
      .command(PluginTestCommand)
      .command(PluginPublishMarketCommand)
      .command(PluginEntryCommand)
      .command(PluginInfoCommand)
      .command(PluginPermissionsCommand)
      .command(PluginApproveCommand)
      .demandCommand(),
  async handler() {},
})
