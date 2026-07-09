import path from "path"
import fs from "fs"
import { EOL } from "os"
import type { Argv } from "yargs"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PluginDescriptor, PluginHooks, PluginInput } from "@ericsanchezok/synergy-plugin"
import { pluginRisk } from "@ericsanchezok/synergy-plugin/permissions"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { PluginId } from "../lib/ids.js"
import { defaultPluginTrustDecision, validateRuntimePolicy, type CheckResult } from "../lib/runtime-policy.js"
import { validateRuntimeDiscovery } from "../lib/runtime-discovery.js"
import { assertCanonicalPluginIdentity, importUrlForEntry, resolveEntryFromPluginDir } from "../lib/spec.js"
import { collectPackagedAssets, resolveUnder } from "../lib/artifact-assets.js"

function scanExports(source: string): string[] {
  const names = new Set<string>()
  const declRe = /^export\s+(?:const|function|class|interface|type|let|var)\s+(\w+)/gm
  let match: RegExpExecArray | null
  while ((match = declRe.exec(source)) !== null) names.add(match[1]!)

  const listRe = /^export\s*\{([^}]+)\}/gm
  while ((match = listRe.exec(source)) !== null) {
    for (const spec of match[1]!.split(",")) {
      const name = spec
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (name) names.add(name)
    }
  }

  if (/^export\s+default\s+(?:function|class|async\s+function)\b/m.test(source)) names.add("default")
  if (/^export\s+default\s+[$A-Z_a-z][$\w]*\s*;?$/m.test(source)) names.add("default")
  return [...names]
}

function isValidJsonSchema(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
  const schema = obj as Record<string, unknown>
  const keywords = [
    "type",
    "properties",
    "required",
    "items",
    "anyOf",
    "oneOf",
    "allOf",
    "enum",
    "const",
    "additionalProperties",
    "patternProperties",
    "$ref",
    "$defs",
    "definitions",
    "title",
    "description",
    "default",
    "examples",
    "format",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
    "pattern",
  ]
  return keywords.some((key) => key in schema)
}

function findUiSource(pluginDir: string): string | undefined {
  const candidates = ["src/ui.tsx", "src/ui/index.tsx", "src/ui.ts", "src/ui/index.ts"]
  return candidates.map((candidate) => path.join(pluginDir, candidate)).find((candidate) => fs.existsSync(candidate))
}

function solidRuntimeInBundle(bundleContent: string): boolean {
  return /\/node_modules\/solid-js\/dist\//.test(bundleContent)
}

function printResults(results: CheckResult[]) {
  const passCount = results.filter((result) => result.type === "pass").length
  const warnCount = results.filter((result) => result.type === "warn").length
  const errorCount = results.filter((result) => result.type === "error").length

  for (const result of results) {
    const prefix =
      result.type === "pass"
        ? `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}`
        : result.type === "warn"
          ? `${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL}`
          : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
    process.stdout.write(`${prefix} ${result.message}${EOL}`)
  }

  process.stdout.write(EOL)
  const parts: string[] = []
  if (passCount > 0) parts.push(`${passCount} passed`)
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`)
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`)
  process.stdout.write(parts.join(", ") + EOL)

  if (errorCount > 0) process.exitCode = 1
}

export async function validatePluginProject(pluginPath: string, options: { runtimeDiscovery?: boolean } = {}) {
  const results: CheckResult[] = []
  const resolved = path.isAbsolute(pluginPath) ? pluginPath : path.resolve(process.cwd(), pluginPath)
  const manifestPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, "plugin.json") : resolved
  const pluginDir = path.dirname(manifestPath)

  let rawManifest: unknown
  let manifest: ReturnType<typeof PluginManifest.safeParse> | null = null
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    manifest = PluginManifest.safeParse(rawManifest)
    if (manifest.success) {
      results.push({ type: "pass", message: "manifest schema valid" })
    } else {
      const issues = manifest.error.issues.map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`).join(EOL)
      results.push({ type: "error", message: `manifest schema invalid${EOL}${issues}` })
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    results.push({
      type: "error",
      message: rawManifest === undefined ? `manifest not found at ${manifestPath}` : `invalid JSON: ${msg}`,
    })
    printResults(results)
    return
  }

  if (!manifest?.success) {
    printResults(results)
    return
  }

  const m = manifest.data
  const id = ((rawManifest as Record<string, unknown>)?.id as string | undefined) ?? m.name
  if (id && PluginId.isValid(id)) results.push({ type: "pass", message: `id "${id}" valid` })
  else results.push({ type: "error", message: `id "${id ?? ""}" invalid - must be lowercase alphanumeric with dashes` })

  if (m.version) results.push({ type: "pass", message: `version ${m.version}` })
  else results.push({ type: "error", message: "version missing" })

  if (m.contributes?.tools && m.contributes.tools.length > 0) {
    if (m.permissions?.tools) results.push({ type: "pass", message: "permissions declared" })
    else results.push({ type: "error", message: "tools contributed but permissions.tools not declared" })
  }

  // V3 UI validation
  if (m.contributes?.ui) {
    const ui = m.contributes.ui
    // V3: permissions.ui is boolean true/false
    if (m.permissions?.ui !== true) {
      results.push({ type: "error", message: "contributes.ui requires permissions.ui: true" })
    } else {
      results.push({ type: "pass", message: "permissions.ui declared" })
    }

    if (ui.entry) {
      const entryPath = path.resolve(pluginDir, ui.entry)
      const uiSource = findUiSource(pluginDir)
      if (fs.existsSync(entryPath)) {
        results.push({ type: "pass", message: `UI entry ${ui.entry} exists` })
        // Check built bundle for Solid runtime leakage
        try {
          const content = fs.readFileSync(entryPath, "utf-8")
          if (solidRuntimeInBundle(content)) {
            results.push({
              type: "error",
              message: `UI bundle ${ui.entry} includes Solid runtime internals (node_modules/solid-js/dist/). Externalize solid-js, solid-js/web, and solid-js/store.`,
            })
          } else {
            results.push({ type: "pass", message: "UI bundle does not ship Solid runtime internals" })
          }
        } catch {
          // skip if can't read
        }
      } else if (uiSource) {
        results.push({
          type: "pass",
          message: `UI entry ${ui.entry} will be built from ${path.relative(pluginDir, uiSource)}`,
        })
      } else {
        results.push({ type: "error", message: `UI entry ${ui.entry} not found` })
      }

      if (uiSource) {
        const exports = scanExports(fs.readFileSync(uiSource, "utf-8"))
        const checkExport = (
          category: string,
          items: Array<{ exportName?: string; id?: string; tool?: string; slot?: string }> | undefined,
        ) => {
          for (const item of items ?? []) {
            const exportName = item.exportName || "default"
            if (!exports.includes(exportName)) {
              const label = item.id ?? item.tool ?? item.slot ?? exportName
              results.push({
                type: "error",
                message: `${category} "${label}" exportName "${exportName}" not found in UI entry`,
              })
            }
          }
        }
        checkExport("workbenchPanel", ui.workbenchPanels)
        checkExport("navigation", ui.navigation)
        checkExport("settings", ui.settings)
        checkExport("toolRenderer", ui.toolRenderers)
        checkExport("partRenderer", ui.partRenderers)
        checkExport("messageSlot", ui.messageSlots)
        checkExport("composerSlot", ui.composerSlots)
        checkExport("uiCommand", ui.commands)
      }
    }
  }

  const uiSource = findUiSource(pluginDir)
  let packagedAssets: ReturnType<typeof collectPackagedAssets> = []
  try {
    packagedAssets = collectPackagedAssets(m)
  } catch (error) {
    results.push({ type: "error", message: error instanceof Error ? error.message : String(error) })
  }
  for (const asset of packagedAssets) {
    if (asset.label === "UI entry" && uiSource && !fs.existsSync(path.resolve(pluginDir, asset.sourceRelative)))
      continue
    try {
      const assetPath = resolveUnder(pluginDir, asset.sourceRelative)
      if (!fs.existsSync(assetPath)) {
        results.push({ type: "error", message: `${asset.label} ${asset.sourceRelative} not found` })
        continue
      }
      const stat = fs.statSync(assetPath)
      if (asset.kind === "dir" && !stat.isDirectory()) {
        results.push({ type: "error", message: `${asset.label} ${asset.sourceRelative} is not a directory` })
      }
      if (asset.kind === "file" && !stat.isFile()) {
        results.push({ type: "error", message: `${asset.label} ${asset.sourceRelative} is not a file` })
      }
    } catch (error) {
      results.push({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const tool of m.contributes?.tools ?? []) {
    if (!tool.capabilities)
      results.push({ type: "warn", message: `tool "${tool.name}" missing capabilities declaration` })
  }

  if (m.contributes?.config?.schema) {
    if (isValidJsonSchema(m.contributes.config.schema)) results.push({ type: "pass", message: "config schema valid" })
    else
      results.push({
        type: "warn",
        message:
          'config schema does not appear to be valid JSON Schema; wrap plugin settings in a top-level schema such as { "type": "object", "properties": { ... } }',
      })
  }

  const risk = pluginRisk(m, { scope: "install" })
  const trust = defaultPluginTrustDecision({ source: "local", devMode: true })
  results.push(
    ...validateRuntimePolicy({
      manifest: m,
      source: trust.source,
      trustTier: trust.tier,
      risk,
      userTrusted: trust.userTrusted,
    }),
  )

  if (options.runtimeDiscovery) {
    const manifestToolNames = (m.contributes?.tools ?? []).map((tool) => tool.name)
    const resolvedEntry = resolveEntryFromPluginDir(pluginDir, m)
    const entryPath = fs.existsSync(resolvedEntry) ? resolvedEntry : null

    if (!entryPath) {
      results.push({
        type: "warn",
        message: "runtime-discovery: no build output found - run 'synergy-plugin build' first",
      })
    } else {
      try {
        const mod = await import(importUrlForEntry(entryPath, Date.now()))
        const descriptors: PluginDescriptor[] = []
        const seenDescriptors = new Set<PluginDescriptor>()
        for (const value of Object.values(mod)) {
          if (value && typeof value === "object" && !Array.isArray(value) && "id" in value && "init" in value) {
            const descriptor = value as PluginDescriptor
            if (!seenDescriptors.has(descriptor)) {
              descriptors.push(descriptor)
              seenDescriptors.add(descriptor)
            }
          }
        }

        if (descriptors.length === 0) {
          results.push({
            type: "warn",
            message: `runtime-discovery: no PluginDescriptor found in ${path.relative(process.cwd(), entryPath)}`,
          })
        } else {
          for (const desc of descriptors) {
            try {
              assertCanonicalPluginIdentity({ manifest: m, descriptor: desc })
            } catch (error) {
              results.push({ type: "error", message: error instanceof Error ? error.message : String(error) })
              continue
            }

            let hooks: PluginHooks | undefined
            let loadError: string | undefined
            try {
              const input: PluginInput = {
                client: undefined as any,
                scope: undefined as any,
                worktree: "",
                directory: pluginDir,
                serverUrl: new URL("http://localhost"),
                $: undefined as any,
                pluginDir,
                config: { get: async () => ({}), set: async () => {} },
                auth: {
                  get: async () => undefined,
                  set: async () => {},
                  delete: async () => {},
                  has: async () => false,
                },
                cache: {
                  directory: path.join(pluginDir, ".cache"),
                  get: async () => undefined,
                  set: async () => {},
                  delete: async () => {},
                },
              }
              hooks = await desc.init(input)
            } catch (error) {
              loadError = error instanceof Error ? error.message : String(error)
            }

            const runtimeToolNames = hooks?.tool ? Object.keys(hooks.tool) : loadError ? null : []
            const discovery = validateRuntimeDiscovery({ manifestToolNames, runtimeToolNames, pluginId: desc.id })
            results.push({
              type: "pass",
              message: `runtime-discovery: loaded plugin "${desc.id}"${loadError ? ` (init failed: ${loadError})` : ""}`,
            })
            if (discovery.loadFailed) {
              results.push({
                type: "error",
                message: `runtime-discovery: plugin "${desc.id}" failed to initialize - cannot validate tool registration`,
              })
              if (loadError) results.push({ type: "error", message: `  init error: ${loadError}` })
            } else {
              const total = runtimeToolNames !== null ? runtimeToolNames.length : 0
              results.push({
                type: "pass",
                message: `runtime-discovery: ${total} tool(s) registered at runtime, ${manifestToolNames.length} declared in manifest`,
              })
              if (discovery.matched.length > 0) {
                results.push({
                  type: "pass",
                  message: `runtime-discovery: ${discovery.matched.length} tool(s) matched - ${discovery.matched.join(", ")}`,
                })
              }
              if (discovery.undeclared.length > 0) {
                results.push({
                  type: "error",
                  message: `runtime-discovery: ${discovery.undeclared.length} undeclared tool(s) - ${discovery.undeclared.join(", ")}`,
                })
              }
              if (discovery.declaredButMissing.length > 0) {
                results.push({
                  type: "warn",
                  message: `runtime-discovery: ${discovery.declaredButMissing.length} tool(s) declared but not registered - ${discovery.declaredButMissing.join(", ")}`,
                })
              }
            }
          }
        }
      } catch (error) {
        results.push({
          type: "error",
          message: `runtime-discovery: failed to load plugin - ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  printResults(results)
}

export const PluginValidateCommand = cmd({
  command: "validate [path]",
  describe: "validate a plugin manifest",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "path to plugin directory or plugin.json (defaults to current directory)",
      })
      .option("runtime-discovery", {
        type: "boolean",
        describe: "safely load plugin in dev mode, collect runtime tools, and compare with manifest",
        default: false,
      }),
  async handler(args) {
    await validatePluginProject((args.path as string) || process.cwd(), {
      runtimeDiscovery: Boolean(args["runtime-discovery"]),
    })
  },
})
