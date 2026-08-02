import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SVG_RASTER_RUNTIME_REQUIRED_PATHS, stageSvgRasterRuntimeAssets } from "../../script/svg-raster-runtime-assets"
import { rasterizeSvgPreview } from "../../src/channel/provider/feishu/svg-raster"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe("standalone SVG raster runtime", () => {
  test("stages the platform-independent SVG raster runtime asset", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-svg-raster-runtime-assets-"))
    temporaryDirectories.push(runtimeDir)

    await stageSvgRasterRuntimeAssets({ runtimeDir })

    for (const relative of SVG_RASTER_RUNTIME_REQUIRED_PATHS) {
      expect(await Bun.file(path.join(runtimeDir, relative)).exists()).toBe(true)
    }
  })

  test("terminates rasterization after its hard timeout", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>')
    await expect(rasterizeSvgPreview(svg, { timeoutMs: 1 })).rejects.toThrow("SVG preview rasterization exceeded 1ms")
  })

  test("rasterizes SVG from a compiled artifact", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-svg-raster-standalone-"))
    temporaryDirectories.push(runtimeDir)
    const binary = path.join(runtimeDir, "bin", process.platform === "win32" ? "probe.exe" : "probe")
    await fs.mkdir(path.dirname(binary), { recursive: true })

    const output = await Bun.build({
      entrypoints: [
        path.join(import.meta.dir, "fixture/svg-raster-standalone-entry.ts"),
        path.join(import.meta.dir, "../../src/channel/provider/feishu/svg-raster-worker.ts"),
      ],
      define: { SYNERGY_STANDALONE: "true" },
      compile: { outfile: binary },
    })
    expect(output.success, output.logs.map((log) => log.message).join("\n")).toBe(true)
    await stageSvgRasterRuntimeAssets({ runtimeDir })

    const proc = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(code, stderr).toBe(0)
    expect(stdout).toContain("standalone SVG raster runtime ready")
  }, 30_000)
})
