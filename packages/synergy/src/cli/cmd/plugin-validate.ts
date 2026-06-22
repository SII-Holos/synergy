import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { PluginId } from "../../plugin/ids"
import { Installation } from "../../global/installation"
import { parseSemver, compareSemverTuples, satisfiesVersion } from "../../util/semver"
import { EOL } from "os"
import path from "path"
import fs from "fs"
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
    yargs.positional("path", {
      type: "string",
      describe: "path to plugin directory or plugin.json (defaults to current directory)",
    }),
  handler(args) {
    const results: CheckResult[] = []

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
