import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sourceProductRoot } from "../src/server-manager"

test("managed source startup resolves the full product entry from source and built Desktop", async () => {
  const desktop = path.resolve(import.meta.dir, "..")
  for (const directory of [path.join(desktop, "src"), path.join(desktop, "dist")]) {
    const product = sourceProductRoot(directory)
    expect(product).not.toBeNull()
    expect((await Bun.file(path.join(product!, "package.json")).json()).name).toBe(
      "@ericsanchezok/synergy-product-runtime",
    )
    expect(await Bun.file(path.join(product!, "src/index.ts")).exists()).toBe(true)
  }
})

test("managed source startup does not resolve a backend outside a source checkout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-missing-source-"))
  try {
    expect(sourceProductRoot(path.join(directory, "app.asar/dist"))).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
