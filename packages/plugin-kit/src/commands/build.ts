import fs from "fs"
import os from "os"
import path from "path"
import type { Argv } from "yargs"
import {
  PluginArtifact,
  PluginManifest,
  compilePluginManifest,
  hasBundledSolidRuntime,
  hasUnlinkedSolidRuntimeImport,
  hasUnsupportedSolidRuntimeImport,
  rewritePluginSolidImports,
  type CompiledPluginArtifacts,
  type PluginContribution,
  type PluginDefinition,
} from "@ericsanchezok/synergy-plugin"
import { cmd } from "../cmd.js"
import { UI } from "../ui.js"
import { sha256File, sha256JSON } from "../lib/crypto.js"
import { hashPackagedFiles, normalizeManifestPath, resolveUnder } from "../lib/artifact-assets.js"
import { loadPluginDefinition } from "../lib/definition.js"
import { solidCompilerPlugin } from "../lib/solid-compiler.js"

function ensureDir(directory: string) {
  fs.mkdirSync(directory, { recursive: true })
}

function copyPath(pluginDir: string, distDir: string, source: string, target = source) {
  const sourceRelative = normalizeManifestPath(source)
  const targetRelative = normalizeManifestPath(target)
  const from = resolveUnder(pluginDir, sourceRelative)
  const to = resolveUnder(distDir, targetRelative)
  if (!fs.existsSync(from)) throw new Error(`Declared plugin asset not found: ${source}`)
  ensureDir(path.dirname(to))
  const stat = fs.statSync(from)
  if (stat.isDirectory()) fs.cpSync(from, to, { recursive: true })
  else if (stat.isFile()) fs.copyFileSync(from, to)
  else throw new Error(`Unsupported plugin asset: ${source}`)
}

function assetPaths(definition: PluginDefinition): Array<{ source: string; target: string }> {
  const result = new Map<string, { source: string; target: string }>()
  const add = (source: string, target = source) => {
    const normalizedTarget = normalizeManifestPath(target)
    if (result.has(normalizedTarget)) throw new Error(`Duplicate packaged plugin asset target: ${normalizedTarget}`)
    result.set(normalizedTarget, { source, target: normalizedTarget })
  }
  for (const asset of definition.assets) add(asset.source, asset.target)
  if (definition.icon && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(definition.icon)) add(definition.icon)
  for (const contribution of definition.contributions) {
    if (contribution.kind === "skill" && contribution.skill.dir) add(contribution.skill.dir)
    if (contribution.kind === "ui.theme" || contribution.kind === "ui.icon") add(contribution.path)
  }
  return [...result.values()]
}

function trustedComponents(contributions: PluginContribution[]) {
  return contributions.flatMap((contribution) => {
    if (!contribution.kind.startsWith("ui.") || !("component" in contribution) || !contribution.component) return []
    return [{ key: `${contribution.kind}:${contribution.id}`, component: contribution.component }]
  })
}

async function buildRuntime(entry: string, distDir: string, required: boolean) {
  if (!required) return undefined
  const outputDirectory = path.join(distDir, path.dirname(PluginArtifact.runtimeEntry))
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outputDirectory,
    target: "bun",
    naming: "index.js",
    define: { "process.env.SYNERGY_PLUGIN_BUNDLE_TARGET": JSON.stringify("runtime") },
  })
  if (!result.success) throw new AggregateError(result.logs, "Plugin runtime build failed")
  const output = path.join(distDir, PluginArtifact.runtimeEntry)
  return { entry: PluginArtifact.runtimeEntry, sha256: sha256File(output) }
}

async function buildUI(pluginDir: string, distDir: string, definition: PluginDefinition) {
  const components = trustedComponents(definition.contributions)
  if (components.length === 0) return undefined

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-plugin-ui-"))
  const entry = path.join(tempDirectory, "index.tsx")
  const exports: Record<string, string> = {}
  const lines: string[] = []
  try {
    components.forEach((item, index) => {
      const source = path.resolve(pluginDir, item.component.source)
      if (!fs.existsSync(source)) throw new Error(`Trusted UI component source not found: ${item.component.source}`)
      const bundledName = `plugin_component_${index}`
      const importedName = item.component.exportName ?? "default"
      const relative = path.relative(tempDirectory, source).split(path.sep).join("/")
      const specifier = relative.startsWith(".") ? relative : `./${relative}`
      lines.push(
        importedName === "default"
          ? `export { default as ${bundledName} } from ${JSON.stringify(specifier)}`
          : `export { ${importedName} as ${bundledName} } from ${JSON.stringify(specifier)}`,
      )
      exports[item.key] = bundledName
    })
    fs.writeFileSync(entry, `${lines.join("\n")}\n`)
    const outputDirectory = path.join(distDir, "ui")
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: outputDirectory,
      target: "browser",
      naming: "index.js",
      external: ["solid-js", "solid-js/web", "solid-js/store"],
      plugins: [solidCompilerPlugin()],
    })
    if (!result.success) throw new AggregateError(result.logs, "Plugin UI build failed")
    const output = path.join(outputDirectory, "index.js")
    const source = fs.readFileSync(output, "utf8")
    if (hasBundledSolidRuntime(source)) throw new Error("Plugin UI bundle contains a private Solid runtime")
    if (hasUnsupportedSolidRuntimeImport(source))
      throw new Error("Plugin UI bundle imports an unsupported Solid module")
    const linked = rewritePluginSolidImports(source)
    if (hasUnlinkedSolidRuntimeImport(linked))
      throw new Error("Plugin UI bundle is not bound to the host Solid runtime")
    fs.writeFileSync(output, linked)
    return { entry: "ui/index.js", sha256: sha256File(output), exports }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
}

export async function buildPluginProject(pluginDir: string, options: { outputDir?: string } = {}): Promise<boolean> {
  try {
    const { entry, definition } = await loadPluginDefinition(pluginDir)
    const distDir = options.outputDir ?? path.join(pluginDir, "dist")
    fs.rmSync(distDir, { recursive: true, force: true })
    ensureDir(distDir)

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Building${UI.Style.TEXT_NORMAL} ${definition.id} v${definition.version}`)
    const runtime = await buildRuntime(
      entry,
      distDir,
      definition.handlerIds.length > 0 || Boolean(definition.activate) || Boolean(definition.deactivate),
    )
    const ui = await buildUI(pluginDir, distDir, definition)
    for (const asset of assetPaths(definition)) copyPath(pluginDir, distDir, asset.source, asset.target)

    const generation = sha256JSON({
      id: definition.id,
      version: definition.version,
      handlers: definition.handlerIds,
      files: hashPackagedFiles(distDir),
    })
    const artifacts: CompiledPluginArtifacts = { generation, ...(runtime ? { runtime } : {}), ...(ui ? { ui } : {}) }
    const manifest = compilePluginManifest(definition, artifacts)
    PluginManifest.parse(manifest)
    const manifestPath = path.join(distDir, PluginArtifact.manifestFile)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.writeFileSync(
      path.join(distDir, PluginArtifact.permissionsSummaryFile),
      `${JSON.stringify(manifest.capabilities, null, 2)}\n`,
    )

    const packagePath = path.join(pluginDir, "package.json")
    if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as Record<string, unknown>
      delete pkg.source
      if (runtime) {
        pkg.main = `./${PluginArtifact.runtimeEntry}`
        pkg.exports = { ".": `./${PluginArtifact.runtimeEntry}` }
      } else {
        delete pkg.main
        delete pkg.exports
      }
      fs.writeFileSync(path.join(distDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
    }

    fs.writeFileSync(
      path.join(distDir, PluginArtifact.integrityFile),
      `${JSON.stringify({ manifest: sha256File(manifestPath), files: hashPackagedFiles(distDir) }, null, 2)}\n`,
    )
    UI.println(`${UI.Style.TEXT_SUCCESS}Built${UI.Style.TEXT_NORMAL} ${definition.id} -> ${distDir}`)
    return true
  } catch (error) {
    UI.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

export const PluginBuildCommand = cmd({
  command: "build [path]",
  describe: "build a plugin definition into an installable package",
  builder: (yargs: Argv) =>
    yargs.positional("path", { type: "string", describe: "plugin directory (defaults to cwd)" }),
  async handler(args) {
    const ok = await buildPluginProject(path.resolve((args.path as string) ?? process.cwd()))
    if (!ok) process.exitCode = 1
  },
})
