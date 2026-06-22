import { validateRuntimePolicy } from "../../plugin/runtime-policy"
import { computeRisk } from "../../plugin/consent/risk"
import { baseCapabilities } from "../../plugin/capability"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginId } from "../../plugin/ids"
import { Installation } from "../../global/installation"
import { parseSemver, compareSemverTuples, satisfiesVersion } from "../../util/semver"
import { EOL } from "os"
import path from "path"
import fs from "fs"
import { validateRuntimeDiscovery } from "../../plugin/validate-runtime-discovery"
import type { PluginDescriptor, PluginInput, PluginHooks } from "@ericsanchezok/synergy-plugin"
import type { Argv } from "yargs"

// ---------------------------------------------------------------------------
// TypeScript export scanning (lightweight regex)
// ---------------------------------------------------------------------------

function scanExports(source: string): string[] {
  const names = new Set<string>()

  // export const/function/class/interface/type/let/var NAME
  const declRe = /^export\s+(?:const|function|class|interface|type|let|var)\s+(\w+)/gm
  let m: RegExpExecArray | null
  while ((m = declRe.exec(source)) !== null) {
    names.add(m[1])
  }

  // export { NAME, ... } or export { NAME as ... }
  const listRe = /^export\s*\{([^}]+)\}/gm
  while ((m = listRe.exec(source)) !== null) {
    const inner = m[1]
    const specs = inner.split(",")
    for (const spec of specs) {
      const name = spec
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if (name) names.add(name)
    }
  }

  // export default (function/class) — default is always available
  // We'll add "default" if there's an export default statement
  if (/^export\s+default\s+(?:function|class|async\s+function)\b/m.test(source)) {
    names.add("default")
  }
  // Also "export default <identifier>" (re-export default from another binding)
  // but that's not usable as a named export, so skip

  return [...names]
}

// ---------------------------------------------------------------------------
// JSON Schema basic validation
// ---------------------------------------------------------------------------

function isValidJsonSchema(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false
  if (typeof obj !== "object" || Array.isArray(obj)) return false
  // Must have at least one standard JSON Schema keyword
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
  return keywords.some((k) => k in schema)
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

interface CheckResult {
  type: "pass" | "warn" | "error"
  message: string
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
    const results: CheckResult[] = []
    const doRuntimeDiscovery = (args["runtime-discovery"] as boolean) || false

    // Resolve the plugin.json path
    const dirArg = (args.path as string) || process.cwd()
    const resolved = path.isAbsolute(dirArg) ? dirArg : path.resolve(process.cwd(), dirArg)
    const manifestPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, "plugin.json") : resolved
    const pluginDir = path.dirname(manifestPath)

    // Load manifest JSON
    let rawManifest: unknown
    let manifest: ReturnType<typeof PluginManifest.safeParse> | null = null

    try {
      const text = fs.readFileSync(manifestPath, "utf-8")
      rawManifest = JSON.parse(text)
      manifest = PluginManifest.safeParse(rawManifest)

      if (manifest.success) {
        results.push({ type: "pass", message: "manifest schema valid" })
      } else {
        const issues = manifest.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join(EOL)
        results.push({ type: "error", message: `manifest schema invalid${EOL}${issues}` })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (rawManifest === undefined) {
        results.push({ type: "error", message: `manifest not found at ${manifestPath}` })
      } else {
        results.push({ type: "error", message: `invalid JSON: ${msg}` })
      }
      // Can't continue without valid data
      printResults(results)
      return
    }

    if (!manifest?.success) {
      // Can't run further checks on invalid schema
      printResults(results)
      return
    }

    const m = manifest.data

    // ── id / name / version ──
    if (m.name) {
      const id = (rawManifest as Record<string, unknown>)?.id as string | undefined
      const checkId = id ?? m.name
      if (PluginId.isValid(checkId)) {
        results.push({ type: "pass", message: `id "${checkId}" valid` })
      } else {
        results.push({
          type: "error",
          message: `id "${checkId}" invalid — must be alphanumeric with dashes (no underscores)`,
        })
      }
    } else {
      results.push({ type: "error", message: "name missing from manifest" })
    }

    if (m.version) {
      results.push({ type: "pass", message: `version ${m.version}` })
    } else {
      results.push({ type: "error", message: "version missing" })
    }

    // ── compatibility ──
    if (m.minSynergyVersion) {
      const currentVersion = Installation.VERSION
      if (currentVersion !== "local") {
        const cur = parseSemver(currentVersion)
        const req = parseSemver(m.minSynergyVersion)
        if (cur && req && compareSemverTuples(cur, req) >= 0) {
          results.push({
            type: "pass",
            message: `synergy version ${currentVersion} satisfies >=${m.minSynergyVersion}`,
          })
        } else {
          results.push({
            type: "warn",
            message: `synergy version ${currentVersion} does not satisfy minSynergyVersion ${m.minSynergyVersion}`,
          })
        }
      }
    }

    if (m.engines?.bun) {
      try {
        const bunVersion = Bun.version
        if (satisfiesVersion(bunVersion, m.engines.bun)) {
          results.push({ type: "pass", message: `bun version ${bunVersion} satisfies ${m.engines.bun}` })
        } else {
          results.push({ type: "warn", message: `bun version ${bunVersion} does not satisfy ${m.engines.bun}` })
        }
      } catch {
        // Bun.version not available in this environment
      }
    }

    // ── permissions completeness ──
    if (m.contributes?.tools && m.contributes.tools.length > 0) {
      if (m.permissions?.tools) {
        results.push({ type: "pass", message: "permissions declared" })
      } else {
        results.push({ type: "error", message: "tools contributed but permissions.tools not declared" })
      }
    }

    // ── UI paths ──
    if (m.contributes?.ui) {
      const ui = m.contributes.ui

      // Check entry file exists
      if (ui.entry) {
        const entryPath = path.resolve(pluginDir, ui.entry)
        if (fs.existsSync(entryPath)) {
          results.push({ type: "pass", message: `UI entry ${ui.entry} exists` })
        } else {
          results.push({ type: "error", message: `UI entry ${ui.entry} not found` })
        }

        // Check exportNames if entry is TypeScript
        if (fs.existsSync(entryPath) && /\.tsx?$/i.test(ui.entry)) {
          try {
            const source = fs.readFileSync(entryPath, "utf-8")
            const exports = scanExports(source)

            const checkExport = (
              category: string,
              items: Array<{ exportName?: string; id?: string; tool?: string }> | undefined,
            ) => {
              if (!items) return
              for (const item of items) {
                const en = item.exportName || "default"
                if (!exports.includes(en)) {
                  const label = item.id ?? item.tool ?? en
                  results.push({
                    type: "error",
                    message: `${category}.exportName "${en}" not found in UI entry`,
                  })
                }
              }
            }

            checkExport("workspacePanel", ui.workspacePanels)
            checkExport("globalPanel", ui.globalPanels)
            checkExport("settings", ui.settings)
            checkExport("toolRenderer", ui.toolRenderers)
            checkExport("partRenderer", ui.partRenderers)
            checkExport("chatComponent", ui.chatComponents)
            checkExport("uiCommand", ui.commands)

            // Also check themes and icons for path existence (covered below in asset paths)
          } catch {
            // Can't read entry file — entry existence already failed above
          }
        }
      }

      // ── asset paths (icons, themes) ──
      if (ui.icons) {
        for (const icon of ui.icons) {
          const iconPath = path.resolve(pluginDir, icon.path)
          if (!fs.existsSync(iconPath)) {
            results.push({ type: "error", message: `icon "${icon.name}" path ${icon.path} not found` })
          }
        }
      }

      if (ui.themes) {
        for (const theme of ui.themes) {
          const themePath = path.resolve(pluginDir, theme.path)
          if (!fs.existsSync(themePath)) {
            results.push({ type: "error", message: `theme "${theme.id}" path ${theme.path} not found` })
          }
        }
      }

      // Check routes entry
      if (ui.routes) {
        for (const route of ui.routes) {
          const routeEntry = path.resolve(pluginDir, route.entry)
          if (!fs.existsSync(routeEntry)) {
            results.push({ type: "error", message: `route "${route.path}" entry ${route.entry} not found` })
          }
        }
      }
    }

    // ── tool capability completeness ──
    if (m.contributes?.tools) {
      for (const tool of m.contributes.tools) {
        if (!tool.capabilities) {
          results.push({
            type: "warn",
            message: `tool "${tool.name}" missing capabilities declaration`,
          })
        }
      }
    }

    // ── config schema ──
    if (m.contributes?.config?.schema) {
      if (isValidJsonSchema(m.contributes.config.schema)) {
        results.push({ type: "pass", message: "config schema valid" })
      } else {
        results.push({ type: "warn", message: "config schema does not appear to be valid JSON Schema" })
      }
    }

    // ── runtime policy (risk-based mode validation) ──
    const pluginRisk = computeRisk(baseCapabilities(m), m)
    // For CLI validation, treat plugin as local (most common)
    // Trust tier defaults to "declarative" since the user hasn't approved it yet in validate
    const policyResults = validateRuntimePolicy({
      manifest: m,
      source: "local",
      trustTier: "declarative",
      risk: pluginRisk,
    })
    results.push(...policyResults)

    // ── runtime discovery (--runtime-discovery flag) ──
    if (doRuntimeDiscovery) {
      const manifestToolNames = (m.contributes?.tools ?? []).map((t) => t.name)
      const buildPath = path.join(pluginDir, "dist", "index.js")
      const mainPath = m.main ? path.resolve(pluginDir, m.main) : buildPath

      // Determine the entry point: prefer dist/index.js, then configured main, then src/index.ts
      let entryPath: string | null = null
      if (fs.existsSync(buildPath)) {
        entryPath = buildPath
      } else if (fs.existsSync(mainPath)) {
        entryPath = mainPath
      } else {
        // Maybe a TypeScript source file exists for dev mode
        const tsMain = m.main ? path.resolve(pluginDir, m.main as string) : buildPath
        const tsAlt = tsMain.replace(/\.js$/, ".ts")
        if (fs.existsSync(tsAlt)) {
          entryPath = tsAlt
        }
      }

      if (!entryPath) {
        results.push({
          type: "warn",
          message: "runtime-discovery: no build output found — run 'synergy plugin build' first",
        })
      } else {
        try {
          const mod = await import(entryPath)
          const descriptors: PluginDescriptor[] = []
          for (const [, v] of Object.entries(mod)) {
            if (v && typeof v === "object" && !Array.isArray(v) && "id" in v && "init" in v) {
              descriptors.push(v as PluginDescriptor)
            }
          }

          if (descriptors.length === 0) {
            results.push({
              type: "warn",
              message: `runtime-discovery: no PluginDescriptor found in ${path.relative(process.cwd(), entryPath)}`,
            })
          } else {
            for (const desc of descriptors) {
              const pluginId = desc.id
              let hooks: PluginHooks | undefined
              let loadError: string | undefined

              try {
                const input: PluginInput = {
                  client: undefined as any, // not available in validate context
                  scope: undefined as any,
                  worktree: "",
                  directory: pluginDir,
                  serverUrl: new URL("http://localhost"),
                  $: undefined as any,
                  pluginDir,
                  config: {
                    get: async () => ({}),
                    set: async () => {},
                  },
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
              } catch (e: unknown) {
                loadError = e instanceof Error ? e.message : String(e)
              }

              const runtimeToolNames = hooks?.tool ? Object.keys(hooks.tool) : loadError ? null : []
              const discovery = validateRuntimeDiscovery({
                manifestToolNames,
                runtimeToolNames,
                pluginId,
              })

              results.push({
                type: "pass",
                message: `runtime-discovery: loaded plugin "${pluginId}"${loadError ? ` (init failed: ${loadError})` : ""}`,
              })

              if (discovery.loadFailed) {
                results.push({
                  type: "error",
                  message: `runtime-discovery: plugin "${pluginId}" failed to initialize — cannot validate tool registration`,
                })
                if (loadError) {
                  results.push({
                    type: "error",
                    message: `  init error: ${loadError}`,
                  })
                }
              } else {
                const total = runtimeToolNames !== null ? runtimeToolNames.length : 0
                results.push({
                  type: "pass",
                  message: `runtime-discovery: ${total} tool(s) registered at runtime, ${manifestToolNames.length} declared in manifest`,
                })

                if (discovery.matched.length > 0) {
                  results.push({
                    type: "pass",
                    message: `runtime-discovery: ${discovery.matched.length} tool(s) matched — ${discovery.matched.join(", ")}`,
                  })
                }

                if (discovery.undeclared.length > 0) {
                  results.push({
                    type: "error",
                    message: `runtime-discovery: ${discovery.undeclared.length} undeclared tool(s) — ${discovery.undeclared.join(", ")} (registered at runtime but missing from manifest contributes.tools)`,
                  })
                }

                if (discovery.declaredButMissing.length > 0) {
                  results.push({
                    type: "warn",
                    message: `runtime-discovery: ${discovery.declaredButMissing.length} tool(s) declared in manifest but not registered at runtime — ${discovery.declaredButMissing.join(", ")}`,
                  })
                }
              }
            }
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          results.push({ type: "error", message: `runtime-discovery: failed to load plugin — ${msg}` })
        }
      }
    }

    printResults(results)
  },
})

function printResults(results: CheckResult[]) {
  const passCount = results.filter((r) => r.type === "pass").length
  const warnCount = results.filter((r) => r.type === "warn").length
  const errorCount = results.filter((r) => r.type === "error").length

  for (const r of results) {
    const prefix =
      r.type === "pass"
        ? `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}`
        : r.type === "warn"
          ? `${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL}`
          : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
    process.stdout.write(`${prefix} ${r.message}${EOL}`)
  }

  process.stdout.write(EOL)
  const parts: string[] = []
  if (passCount > 0) parts.push(`${passCount} passed`)
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`)
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`)
  process.stdout.write(parts.join(", ") + EOL)

  if (errorCount > 0) {
    process.exitCode = 1
  }
}
