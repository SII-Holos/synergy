import { expect, test } from "bun:test"
import path from "node:path"
import { compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import { readPluginUIAsset } from "../../src/plugin/ui-assets"
import { tmpdir } from "../fixture/fixture"

test("serves only declared assets of the requested generation and rejects changed executable bytes", async () => {
  await using directory = await tmpdir()
  const source = "export const Panel = () => null"
  const manifest = compilePluginManifest(
    definePlugin({ id: "asset-fixture", version: "1.0.0", description: "Asset fixture", contributions: [] }),
    {
      generation: "current",
      ui: {
        apiVersion: "5.0",
        entry: "ui/index.js",
        sha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
        resources: [],
        exports: {},
      },
    },
  )
  const plugin = { pluginDir: directory.path, manifest }
  await Bun.write(path.join(directory.path, "ui/index.js"), source)
  await Bun.write(path.join(directory.path, "private.txt"), "not an asset")
  const asset = await readPluginUIAsset(plugin, "ui/index.js", "current")
  expect(new TextDecoder().decode(asset?.data)).toBe(source)
  expect(asset?.mime).toBe("text/javascript")
  expect(asset?.cacheControl).toContain("immutable")
  expect(await readPluginUIAsset(plugin, "ui/index.js", "previous")).toBeUndefined()
  expect(await readPluginUIAsset(plugin, "private.txt", "current")).toBeUndefined()
  expect(await readPluginUIAsset(plugin, "../private.txt", "current")).toBeUndefined()
  await Bun.write(path.join(directory.path, "ui/index.js"), "changed bytes")
  expect(await readPluginUIAsset(plugin, "ui/index.js", "current")).toBeUndefined()
})

test("Skin resources are authorized by manifest hashes, never by mutable Skin JSON or integrity files", async () => {
  await using directory = await tmpdir()
  const skinSource = JSON.stringify({
    version: 1,
    id: "paper",
    light: {},
    dark: {},
    narrow: {},
    reducedMotion: { decorations: "hide" },
    assets: {},
  })
  const texture = '<svg xmlns="http://www.w3.org/2000/svg"/>'
  const hash = (source: string) => new Bun.CryptoHasher("sha256").update(source).digest("hex")
  const manifest = compilePluginManifest(
    definePlugin({
      id: "skin-fixture",
      version: "1.0.0",
      description: "Skin",
      contributions: [{ kind: "ui.skin", id: "paper", label: "Paper", path: "skins/paper.json" }],
    }),
    {
      generation: "current",
      skins: { paper: { sha256: hash(skinSource), assets: [{ entry: "assets/paper.svg", sha256: hash(texture) }] } },
    },
  )
  const plugin = { pluginDir: directory.path, manifest }
  await Bun.write(path.join(directory.path, "skins/paper.json"), skinSource)
  await Bun.write(path.join(directory.path, "assets/paper.svg"), texture)
  expect((await readPluginUIAsset(plugin, "assets/paper.svg", "current"))?.mime).toBe("image/svg+xml")
  await Bun.write(
    path.join(directory.path, "skins/paper.json"),
    JSON.stringify({ assets: { stolen: { path: "secret.json" } } }),
  )
  await Bun.write(path.join(directory.path, "secret.json"), "private")
  await Bun.write(
    path.join(directory.path, "integrity.json"),
    JSON.stringify({ files: { "secret.json": hash("private") } }),
  )
  expect(await readPluginUIAsset(plugin, "skins/paper.json", "current")).toBeUndefined()
  expect(await readPluginUIAsset(plugin, "secret.json", "current")).toBeUndefined()
  await Bun.write(path.join(directory.path, "assets/paper.svg"), "changed")
  expect(await readPluginUIAsset(plugin, "assets/paper.svg", "current")).toBeUndefined()
})
