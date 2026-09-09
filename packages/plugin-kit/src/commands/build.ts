import { generatePluginDataTypes } from "../lib/typegen.js"
import { createUIAssetPlugin } from "../lib/ui-asset-plugin.js"
import fs from "fs"
import path from "path"
import type { Argv } from "yargs"
import {
  PluginArtifact,
  PLUGIN_UI_API_VERSION,
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
import { scopePluginCSS } from "../lib/ui-css.js"
import { validateSkinAssets } from "../lib/skin-assets.js"
import { validateThemeAssets } from "../lib/theme-assets.js"

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

function assetPaths(pluginDir: string, definition: PluginDefinition): Array<{ source: string; target: string }> {
  const result = new Map<string, { source: string; target: string }>()
  const add = (source: string, target = source) => {
    const normalizedTarget = normalizeManifestPath(target)
    if (result.has(normalizedTarget)) {
      if (result.get(normalizedTarget)?.source === source) return
      throw new Error(`Duplicate packaged plugin asset target: ${normalizedTarget}`)
    }
    result.set(normalizedTarget, { source, target: normalizedTarget })
  }
  for (const asset of definition.assets) add(asset.source, asset.target)
  if (definition.icon && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(definition.icon)) add(definition.icon)
  for (const contribution of definition.contributions) {
    if (contribution.kind === "skill" && contribution.skill.dir) add(contribution.skill.dir)
    if (contribution.kind === "ui.theme" || contribution.kind === "ui.icon" || contribution.kind === "ui.skin")
      add(contribution.path)
  }
  for (const { skin } of validateSkinAssets(pluginDir, definition.contributions)) {
    for (const asset of Object.values(skin.assets)) add(asset.path)
  }
  return [...result.values()]
}

function trustedComponents(contributions: PluginContribution[]) {
  return contributions.flatMap((contribution) => {
    if (contribution.kind === "ui.shell") {
      return [
        { key: `${contribution.kind}:${contribution.id}`, component: contribution.component },
        ...Object.entries(contribution.pages ?? {}).map(([page, component]) => ({
          key: `${contribution.kind}:${contribution.id}:${page}`,
          component,
        })),
      ]
    }
    if (contribution.kind === "ui.textAction" && contribution.presentation) {
      return [{ key: `${contribution.kind}:${contribution.id}`, component: contribution.presentation.component }]
    }
    if (!contribution.kind.startsWith("ui.") || !("component" in contribution) || !contribution.component) return []
    return [{ key: `${contribution.kind}:${contribution.id}`, component: contribution.component }]
  })
}

function runtimeSourceLoader(): Bun.BunPlugin {
  return {
    name: "plugin-runtime-source-loader",
    setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path: sourcePath }) => {
        const extension = path.extname(sourcePath)
        const loader = extension.endsWith("x")
          ? extension.includes("t")
            ? "tsx"
            : "jsx"
          : extension.includes("t")
            ? "ts"
            : "js"
        return { contents: fs.readFileSync(sourcePath, "utf8"), loader }
      })
    },
  }
}

async function buildRuntime(entry: string, distDir: string, required: boolean, dependencies: Set<string>) {
  if (!required) return undefined
  const outputDirectory = path.join(distDir, path.dirname(PluginArtifact.runtimeEntry))
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outputDirectory,
    target: "bun",
    metafile: true,
    naming: "index.js",
    define: { "process.env.SYNERGY_PLUGIN_BUNDLE_TARGET": JSON.stringify("runtime") },
    plugins: [runtimeSourceLoader()],
  })
  collectDependencies(result, dependencies)
  if (!result.success) throw new AggregateError(result.logs, "Plugin runtime build failed")
  const output = path.join(distDir, PluginArtifact.runtimeEntry)
  return { entry: PluginArtifact.runtimeEntry, sha256: sha256File(output) }
}

async function buildUI(pluginDir: string, distDir: string, definition: PluginDefinition, dependencies: Set<string>) {
  const components = trustedComponents(definition.contributions)
  if (components.length === 0) return undefined

  const tempDirectory = fs.mkdtempSync(path.join(pluginDir, ".synergy-plugin-ui-"))
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
    const assets = createUIAssetPlugin(outputDirectory)
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: outputDirectory,
      target: "browser",
      metafile: true,
      naming: "index.[ext]",
      external: ["solid-js", "solid-js/web", "solid-js/store"],
      loader: {
        ".woff": "file",
        ".woff2": "file",
        ".ttf": "file",
        ".otf": "file",
        ".png": "file",
        ".jpg": "file",
        ".webp": "file",
        ".svg": "file",
      },
      plugins: [assets.plugin, solidCompilerPlugin()],
    })
    collectDependencies(result, dependencies)
    if (!result.success) {
      const details = result.logs.map((log) => log.message).join("\n")
      throw new Error(details ? `Plugin UI build failed:\n${details}` : "Plugin UI build failed")
    }
    const output = path.join(outputDirectory, "index.js")
    const source = fs.readFileSync(output, "utf8")
    if (hasBundledSolidRuntime(source)) throw new Error("Plugin UI bundle contains a private Solid runtime")
    if (hasUnsupportedSolidRuntimeImport(source))
      throw new Error("Plugin UI bundle imports an unsupported Solid module")
    const linked = rewritePluginSolidImports(source)
    if (hasUnlinkedSolidRuntimeImport(linked))
      throw new Error("Plugin UI bundle is not bound to the host Solid runtime")
    fs.writeFileSync(output, linked)
    for (const asset of result.outputs) {
      if (!asset.path.endsWith(".css")) continue
      fs.writeFileSync(asset.path, scopePluginCSS(fs.readFileSync(asset.path, "utf8"), definition.id))
    }
    const resources = [...new Set([...result.outputs.map((asset) => asset.path), ...assets.outputs])]
      .filter((asset) => path.resolve(asset) !== path.resolve(output))
      .map((asset) => ({
        entry: path.relative(distDir, asset).split(path.sep).join("/"),
        sha256: sha256File(asset),
        kind: asset.endsWith(".css") ? ("stylesheet" as const) : ("asset" as const),
      }))
      .sort((a, b) => a.entry.localeCompare(b.entry))
    return { apiVersion: PLUGIN_UI_API_VERSION, entry: "ui/index.js", sha256: sha256File(output), resources, exports }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
}

export async function buildPluginProject(
  pluginDir: string,
  options: { outputDir?: string; dependencies?(files: string[], valid: boolean): void } = {},
): Promise<boolean> {
  let valid = false
  const dependencies = new Set<string>()
  let staging: string | undefined
  try {
    const { entry, definition } = await loadPluginDefinition(pluginDir)
    dependencies.add(entry)
    await generatePluginDataTypes(pluginDir, definition)
    validateThemeAssets(pluginDir, definition.contributions)
    const declaredAssets = assetPaths(pluginDir, definition)
    for (const asset of declaredAssets) dependencies.add(path.resolve(pluginDir, asset.source))
    const outputDir = path.resolve(options.outputDir ?? path.join(pluginDir, "dist"))
    ensureDir(path.dirname(outputDir))
    const distDir = fs.mkdtempSync(path.join(path.dirname(outputDir), ".synergy-plugin-build-"))
    staging = distDir

    UI.println(`${UI.Style.TEXT_NORMAL_BOLD}Building${UI.Style.TEXT_NORMAL} ${definition.id} v${definition.version}`)
    const runtime = await buildRuntime(
      entry,
      distDir,
      definition.handlerIds.length > 0 || Boolean(definition.activate) || Boolean(definition.deactivate),
      dependencies,
    )
    const ui = await buildUI(pluginDir, distDir, definition, dependencies)
    for (const asset of declaredAssets) copyPath(pluginDir, distDir, asset.source, asset.target)
    validateThemeAssets(distDir, definition.contributions)
    const skins = Object.fromEntries(
      validateSkinAssets(distDir, definition.contributions).map(({ contribution, skin }) => [
        contribution.id,
        {
          sha256: sha256File(path.join(distDir, contribution.path!)),
          assets: [...new Set(Object.values(skin.assets).map((asset) => asset.path))]
            .sort()
            .map((entry) => ({ entry, sha256: sha256File(path.join(distDir, entry)) })),
        },
      ]),
    )

    const artifacts: CompiledPluginArtifacts = {
      generation: "pending",
      skins,
      ...(runtime ? { runtime } : {}),
      ...(ui ? { ui } : {}),
    }
    const manifest = compilePluginManifest(definition, artifacts)
    manifest.artifacts.generation = sha256JSON({ manifest, files: hashPackagedFiles(distDir) })
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
    const previous = `${distDir}-previous`
    const hasPrevious = fs.existsSync(outputDir)
    if (hasPrevious) fs.renameSync(outputDir, previous)
    try {
      fs.renameSync(distDir, outputDir)
    } catch (error) {
      if (hasPrevious) fs.renameSync(previous, outputDir)
      throw error
    }
    staging = undefined
    if (hasPrevious) {
      try {
        fs.rmSync(previous, { recursive: true, force: true })
      } catch {
        UI.error("Build succeeded; previous artifact cleanup failed")
      }
    }
    UI.println(`${UI.Style.TEXT_SUCCESS}Built${UI.Style.TEXT_NORMAL} ${definition.id} -> ${outputDir}`)
    valid = true
    return true
  } catch (error) {
    UI.error(buildErrorMessage(error))
    return false
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    options.dependencies?.(
      [...dependencies].filter((file) => fs.existsSync(file)),
      valid,
    )
  }
}

function buildErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join("\n")
    return details || error.message
  }
  return error instanceof Error ? error.message : String(error)
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

function collectDependencies(result: Bun.BuildOutput, dependencies: Set<string>) {
  for (const file of Object.keys(result.metafile?.inputs ?? {})) {
    const normalized = file.replace(/^synergy-ui-asset:/, "")
    dependencies.add(path.resolve(normalized))
  }
}
