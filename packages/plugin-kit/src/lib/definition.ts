import fs from "fs"
import path from "path"
import type { PluginDefinition } from "@ericsanchezok/synergy-plugin"

export function resolveDefinitionEntry(pluginDir: string): string {
  const packagePath = path.join(pluginDir, "package.json")
  const candidates: string[] = []
  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
      source?: string
      exports?: string | { "."?: string | { bun?: string; import?: string } }
      main?: string
    }
    if (pkg.source) candidates.push(path.resolve(pluginDir, pkg.source))
    const rootExport = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."]
    if (typeof rootExport === "string") candidates.push(path.resolve(pluginDir, rootExport))
    if (rootExport && typeof rootExport === "object") {
      if (rootExport.bun) candidates.push(path.resolve(pluginDir, rootExport.bun))
      if (rootExport.import) candidates.push(path.resolve(pluginDir, rootExport.import))
    }
    if (pkg.main) candidates.push(path.resolve(pluginDir, pkg.main))
  }
  candidates.push(path.join(pluginDir, "src", "index.ts"), path.join(pluginDir, "index.ts"))
  const entry = candidates.find((candidate) => fs.existsSync(candidate))
  if (!entry) throw new Error(`Plugin definition entry not found in ${pluginDir}`)
  return entry
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === "string" &&
    typeof record.version === "string" &&
    Array.isArray(record.contributions) &&
    Array.isArray(record.handlerIds)
  )
}

const marker = "__SYNERGY_PLUGIN_DEFINITION__"

// Bun's documented CLI mode resolves author dependencies from disk even when
// Plugin Kit is embedded in a standalone executable: https://bun.com/docs/bundler/executables
const loaderSource = `
import { schemaToJsonSchema } from "@ericsanchezok/synergy-plugin"
import { pathToFileURL } from "node:url"
const entry = process.argv.at(-1)
const module = await import(pathToFileURL(entry).href)
const definition = [module.default, ...Object.values(module)].find(value =>
  value && typeof value === "object" && typeof value.id === "string" &&
  typeof value.version === "string" && Array.isArray(value.contributions) && Array.isArray(value.handlerIds))
if (!definition) throw new Error("No definePlugin() definition exported by " + entry)
const contributions = definition.contributions.map(item => {
  if (item.kind === "operation") return { ...item, input: schemaToJsonSchema(item.input), output: schemaToJsonSchema(item.output) }
  if (item.kind === "event") return { ...item, payload: schemaToJsonSchema(item.payload) }
  if (item.kind === "tool") return { ...item, input: schemaToJsonSchema(item.input) }
  return item
})
process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ ...definition, contributions,
  __hasActivate: typeof definition.activate === "function", __hasDeactivate: typeof definition.deactivate === "function" }))
`

export async function loadPluginDefinition(pluginDir: string): Promise<{
  entry: string
  definition: PluginDefinition
}> {
  const entry = resolveDefinitionEntry(pluginDir)
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", loaderSource, entry],
    env: { ...process.env, BUN_BE_BUN: "1" },
    cwd: pluginDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `Failed to load plugin definition from ${entry}`)
  const offset = stdout.lastIndexOf(marker)
  if (offset < 0) throw new Error(`Plugin definition loader returned no descriptor for ${entry}`)
  const snapshot = JSON.parse(stdout.slice(offset + marker.length)) as Record<string, unknown>
  if (!isPluginDefinition(snapshot)) throw new Error(`No definePlugin() definition exported by ${entry}`)
  if (snapshot.__hasActivate) snapshot.activate = async () => undefined
  if (snapshot.__hasDeactivate) snapshot.deactivate = async () => undefined
  delete snapshot.__hasActivate
  delete snapshot.__hasDeactivate
  return { entry, definition: snapshot }
}
