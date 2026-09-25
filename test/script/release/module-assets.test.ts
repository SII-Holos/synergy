import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { buildWorkspace } from "../../../script/build-workspace"

test("the Library module initializes its own WASM backend outside the repository", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-library-modules-"))
  try {
    const { output } = await buildWorkspace("packages/library", { output: directory })
    expect(await Bun.file(path.join(output, "vector/packaged-embedding.js")).exists()).toBe(true)
    const entry = pathToFileURL(path.join(output, "vector/embedding-runtime.js")).href
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const module=await import(${JSON.stringify(entry)}); await module.verifyStandaloneEmbeddingRuntime(); console.log('module embedding ready')`,
      ],
      {
        cwd: directory,
        env: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain("module embedding ready")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 60_000)

test("Connections modules carry the SVG raster fonts, notices and WASM", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-connections-modules-"))
  try {
    const { output } = await buildWorkspace("packages/connections", { output: directory })
    for (const name of [
      "index_bg.wasm",
      "THIRD_PARTY_NOTICES.txt",
      "fonts/noto-sans-sc-chinese-simplified-400-normal.woff2",
      "fonts/LICENSE-OFL-1.1.txt",
    ])
      expect(await Bun.file(path.join(output, "lib/resvg-wasm", name)).exists()).toBe(true)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
