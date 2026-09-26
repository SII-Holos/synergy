import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { buildWorkspace } from "../../script/build-workspace"

test("nested module output keeps its owning package version and relative entry URLs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-module-build-"))
  try {
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "build-fixture", version: "2.0.0", type: "module", exports: { ".": "./src/index.ts" } }),
    )
    await Bun.write(
      path.join(directory, "src/index.ts"),
      'import { version } from "../package.json" with { type: "json" }; export const metadata = { version, worker: new URL("./worker.ts", import.meta.url) };',
    )
    await Bun.write(path.join(directory, "src/worker.ts"), 'export const role = "agent"')
    const result = await buildWorkspace(directory, { output: "dist/modules" })
    const { metadata } = await import(pathToFileURL(path.join(result.output, "index.js")).href)
    expect(metadata.version).toBe("2.0.0")
    expect((await import(metadata.worker.href)).role).toBe("agent")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
