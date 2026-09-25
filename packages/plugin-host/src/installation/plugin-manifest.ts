import { parseSkin } from "@ericsanchezok/synergy-plugin/skin"
import { PluginManifestEnvelope, PluginManifestV4, type PluginManifestType } from "@ericsanchezok/synergy-plugin"
import path from "node:path"
import fs from "node:fs"
import { sha256File } from "./files"

function isPathContained(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function assertPluginCompatibility(
  envelope: { apiVersion: string; compatibility: { synergy: string }; manifestVersion?: number },
  hostVersion: string,
): void {
  if (envelope.apiVersion !== "4.0") {
    throw new Error(
      `Plugin API ${envelope.apiVersion} is not supported. This Synergy release supports the stable Plugin API 4 family.`,
    )
  }
  if (hostVersion === "local") return
  if (!Bun.semver.satisfies(hostVersion, envelope.compatibility.synergy)) {
    throw new Error(
      `Plugin requires Synergy ${envelope.compatibility.synergy}, but the current version is ${hostVersion}.`,
    )
  }
}

export async function readPluginManifest(
  pluginDir: string,
  hostVersion: string,
  filename = "plugin.json",
): Promise<PluginManifestType> {
  const manifestPath = path.join(pluginDir, filename)
  const file = Bun.file(manifestPath)
  if (!(await file.exists().catch(() => false))) {
    throw new Error(`Plugin manifest not found at ${manifestPath}. Synergy plugins must include plugin.json.`)
  }
  const text = await file.text()
  if (!text.trim()) {
    throw new Error(`Plugin manifest is empty at ${manifestPath}. Synergy plugins must include a valid plugin.json.`)
  }
  const raw = JSON.parse(text)
  const envelope = PluginManifestEnvelope.parse(raw)
  assertPluginCompatibility(envelope, hostVersion)
  const manifest = PluginManifestV4.parse(raw)
  const artifacts = [
    { kind: "runtime", artifact: manifest.artifacts.runtime },
    { kind: "ui", artifact: manifest.artifacts.ui },
    ...(manifest.artifacts.ui?.resources ?? []).map((artifact) => ({ kind: "ui resource", artifact })),
    ...manifest.contributions.flatMap((item) =>
      item.kind === "ui.skin"
        ? [
            { kind: "Skin", artifact: { entry: item.path, sha256: item.sha256 } },
            ...item.assets.map((artifact) => ({ kind: "Skin resource", artifact })),
          ]
        : [],
    ),
  ]
  for (const { kind, artifact } of artifacts) {
    if (!artifact) continue
    const artifactPath = path.resolve(pluginDir, artifact.entry)
    if (!isPathContained(pluginDir, artifactPath))
      throw new Error(`Plugin ${kind} artifact escapes its package: ${artifact.entry}`)
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      throw new Error(`Plugin ${kind} artifact not found: ${artifact.entry}`)
    }
    if (!isPathContained(await fs.promises.realpath(pluginDir), await fs.promises.realpath(artifactPath)))
      throw new Error(`Plugin ${kind} artifact escapes its package: ${artifact.entry}`)
    const actual = await sha256File(artifactPath)
    if (actual !== artifact.sha256) throw new Error(`Plugin ${kind} artifact integrity mismatch: ${artifact.entry}`)
  }
  for (const item of manifest.contributions) {
    if (item.kind !== "ui.skin") continue
    const skin = parseSkin(await Bun.file(path.join(pluginDir, item.path)).json())
    if (skin.id !== item.id) throw new Error(`Skin ID does not match contribution ${item.id}`)
    const paths = new Set(Object.values(skin.assets).map((asset) => asset.path))
    if (paths.size !== item.assets.length || item.assets.some((asset) => !paths.has(asset.entry)))
      throw new Error(`Skin ${item.id} resource manifest does not match its definition`)
  }
  return manifest
}
