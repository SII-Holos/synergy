import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import {
  archiveCacheDir,
  assertCanonicalPluginIdentity,
  importUrlForEntry,
  resolvePluginSpec,
} from "../../src/plugin/spec-resolver"

const encoder = new TextEncoder()

async function writePlugin(dir: string, id = "resolver-plugin") {
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: id,
        version: "0.1.0",
        main: "./src/index.ts",
        description: "Resolver test plugin",
      },
      null,
      2,
    ),
  )
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: id, version: "0.1.0", type: "module", main: "./src/index.ts" }, null, 2),
  )
  await Bun.write(path.join(dir, "src", "index.ts"), `export default { id: "${id}", async init() { return {} } }\n`)
}

function tarHeader(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  const writeString = (offset: number, length: number, value: string) => {
    header.set(encoder.encode(value).slice(0, length), offset)
  }
  const writeOctal = (offset: number, length: number, value: number) => {
    const text =
      value
        .toString(8)
        .padStart(length - 1, "0")
        .slice(-(length - 1)) + "\0"
    writeString(offset, length, text)
  }

  writeString(0, 100, name)
  writeOctal(100, 8, 0o644)
  writeOctal(108, 8, 0)
  writeOctal(116, 8, 0)
  writeOctal(124, 12, content.byteLength)
  writeOctal(136, 12, 0)
  header.fill(0x20, 148, 156)
  writeString(156, 1, "0")
  writeString(257, 6, "ustar\0")
  writeString(263, 2, "00")

  let checksum = 0
  for (const byte of header) checksum += byte
  writeString(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ")
  return header
}

function tarGz(entries: Array<{ name: string; content: string }>): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    const content = encoder.encode(entry.content)
    chunks.push(tarHeader(entry.name, content), content)
    const padding = (512 - (content.byteLength % 512)) % 512
    if (padding) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(1024))
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const tar = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    tar.set(chunk, offset)
    offset += chunk.byteLength
  }
  return Bun.gzipSync(tar)
}

describe("resolvePluginSpec", () => {
  test("resolves file:// directories to canonical plugin manifest and entry", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir) })

    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })

    expect(resolved.source).toBe("local")
    expect(resolved.pkg).toBe("resolver-plugin")
    expect(resolved.version).toBe("0.1.0")
    expect(resolved.pluginDir).toBe(tmp.path)
    expect(resolved.entryPath).toBe(path.join(tmp.path, "src", "index.ts"))
    expect(resolved.manifest.name).toBe("resolver-plugin")
  })

  test("resolves file:// entry files without losing the package root", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "entry-file-plugin") })
    const entryPath = path.join(tmp.path, "src", "index.ts")

    const resolved = await resolvePluginSpec(pathToFileURL(entryPath).href, { install: false })

    expect(resolved.pluginDir).toBe(tmp.path)
    expect(resolved.entryPath).toBe(entryPath)
    expect(resolved.manifest.name).toBe("entry-file-plugin")
  })

  test("resolves packed plugin archives as local installable specs", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "archive-plugin") })
    await using archiveTmp = await tmpdir()
    const archivePath = path.join(archiveTmp.path, "archive-plugin-0.1.0.synergy-plugin.tgz")
    const result = Bun.spawnSync(["tar", "-czf", archivePath, "-C", tmp.path, "."])
    expect(result.exitCode).toBe(0)

    const resolved = await resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })

    expect(resolved.source).toBe("local")
    expect(resolved.pkg).toBe("archive-plugin")
    expect(resolved.manifest.name).toBe("archive-plugin")
    expect(resolved.entryPath.endsWith(path.join("src", "index.ts"))).toBe(true)
  })

  test("rebuilds an empty archive cache before reading plugin.json", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "empty-cache-plugin") })
    await using archiveTmp = await tmpdir()
    const archivePath = path.join(archiveTmp.path, "empty-cache-plugin-0.1.0.synergy-plugin.tgz")
    const result = Bun.spawnSync(["tar", "-czf", archivePath, "-C", tmp.path, "."])
    expect(result.exitCode).toBe(0)

    const first = await resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })
    const cacheDir = archiveCacheDir(archivePath)
    expect(first.pluginDir).toBe(cacheDir)
    await fs.rm(cacheDir, { recursive: true, force: true })
    await fs.mkdir(cacheDir, { recursive: true })
    expect(await Bun.file(path.join(cacheDir, "plugin.json")).exists()).toBe(false)

    const rebuilt = await resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })

    expect(rebuilt.pluginDir).toBe(cacheDir)
    expect(rebuilt.manifest.name).toBe("empty-cache-plugin")
    expect(await Bun.file(path.join(cacheDir, "plugin.json")).exists()).toBe(true)
    expect(await Bun.file(rebuilt.entryPath).exists()).toBe(true)
  })

  test("keeps an existing usable archive cache when the source archive becomes unreadable", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "cached-archive-plugin") })
    await using archiveTmp = await tmpdir()
    const archivePath = path.join(archiveTmp.path, "cached-archive-plugin-0.1.0.synergy-plugin.tgz")
    const result = Bun.spawnSync(["tar", "-czf", archivePath, "-C", tmp.path, "."])
    expect(result.exitCode).toBe(0)

    const first = await resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })
    await Bun.write(archivePath, "not a tarball")

    const resolved = await resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })

    expect(resolved.pluginDir).toBe(first.pluginDir)
    expect(resolved.manifest.name).toBe("cached-archive-plugin")
    expect(await Bun.file(path.join(first.pluginDir, "plugin.json")).exists()).toBe(true)
  })

  test("rejects local plugin archives with unsafe entries before extraction", async () => {
    await using tmp = await tmpdir()
    const archivePath = path.join(tmp.path, "unsafe-plugin-0.1.0.synergy-plugin.tgz")
    await Bun.write(archivePath, tarGz([{ name: "../plugin.json", content: "{}" }]))

    await expect(resolvePluginSpec(pathToFileURL(archivePath).href, { install: false })).rejects.toThrow("unsafe path")
  })

  test("rejects plugin directories without plugin.json", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
        await Bun.write(
          path.join(dir, "src", "index.ts"),
          `export default { id: "missing-manifest", async init() { return {} } }\n`,
        )
      },
    })

    await expect(resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })).rejects.toThrow(
      "Plugin manifest not found",
    )
  })
})

describe("assertCanonicalPluginIdentity", () => {
  test("accepts object descriptors whose id matches plugin.json name", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "canonical-plugin") })
    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })
    const mod = await import(importUrlForEntry(resolved.entryPath, Date.now()))

    expect(() =>
      assertCanonicalPluginIdentity({
        manifest: resolved.manifest,
        descriptor: mod.default,
      }),
    ).not.toThrow()
  })

  test("rejects mismatched descriptor id and plugin.json name", async () => {
    await using tmp = await tmpdir({ init: (dir) => writePlugin(dir, "manifest-id") })
    const resolved = await resolvePluginSpec(pathToFileURL(tmp.path).href, { install: false })

    expect(() =>
      assertCanonicalPluginIdentity({
        manifest: resolved.manifest,
        descriptor: {
          id: "descriptor-id",
          async init() {
            return {}
          },
        },
      }),
    ).toThrow('plugin.json name "manifest-id" must match PluginDescriptor.id "descriptor-id"')
  })
})
