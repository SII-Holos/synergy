import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { localRegistryArtifactDir } from "../../src/plugin/local-registry-store"
import { classifyPluginInstallation, PluginStatusSchema } from "../../src/plugin/status"

describe("plugin installation classification", () => {
  test("PluginStatus uses installation origin instead of the overloaded source field", () => {
    expect(PluginStatusSchema.shape).toHaveProperty("installation")
    expect(PluginStatusSchema.shape).not.toHaveProperty("source")
  })

  test("distinguishes directory, archive, registry, package and builtin installations", () => {
    const directory = path.resolve("C:/plugins/focus/dist")
    expect(
      classifyPluginInstallation({ spec: pathToFileURL(directory).href, source: "local", pluginDir: directory }),
    ).toEqual({ kind: "directory", spec: pathToFileURL(directory).href, path: directory })

    const archive = path.resolve("C:/plugins/focus.synergy-plugin.tgz")
    expect(classifyPluginInstallation({ spec: pathToFileURL(archive).href, source: "local" })).toEqual({
      kind: "archive",
      spec: pathToFileURL(archive).href,
      path: archive,
    })

    const localRegistryArtifact = path.join(localRegistryArtifactDir("focus", "1.0.0"), "focus.tgz")
    expect(classifyPluginInstallation({ spec: pathToFileURL(localRegistryArtifact).href, source: "local" })).toEqual({
      kind: "registry",
      registry: "local",
      spec: pathToFileURL(localRegistryArtifact).href,
    })

    expect(classifyPluginInstallation({ spec: pathToFileURL(archive).href, source: "official" })).toEqual({
      kind: "registry",
      registry: "official",
      spec: pathToFileURL(archive).href,
    })
    expect(classifyPluginInstallation({ spec: "github:owner/plugin", source: "git" })).toEqual({
      kind: "package",
      source: "git",
      spec: "github:owner/plugin",
    })
    expect(classifyPluginInstallation({ spec: "builtin:plugin", source: "builtin" })).toEqual({
      kind: "builtin",
      spec: "builtin:plugin",
    })
  })
})
