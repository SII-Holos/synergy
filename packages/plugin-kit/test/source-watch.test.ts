import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { watchPluginSources } from "../src/lib/source-watch"
import { createFixtureProject } from "./fixtures"

test("watcher follows new asset directories and external dependencies without watching its own output", async () => {
  const project = createFixtureProject("watch-assets")
  const dependency = createFixtureProject("watch-dependency")
  let changes = 0
  const watcher = watchPluginSources(project.root, () => {
    changes++
  })
  try {
    dependency.writeFile("shared.ts", "export const value = 1")
    watcher.update([path.join(dependency.root, "shared.ts")])
    project.writeFile("skins/new/texture.svg", "first")
    await Bun.sleep(400)
    expect(changes).toBe(1)
    dependency.writeFile("shared.ts", "export const value = 2")
    await Bun.sleep(400)
    expect(changes).toBe(2)
    watcher.update([], false)
    dependency.writeFile("shared.ts", "export const value = 3")
    await Bun.sleep(400)
    expect(changes).toBe(3)
    project.writeFile("dist/ui/index.js", "generated")
    project.writeFile("src/generated/plugin-data/index.d.ts", "generated")
    await Bun.sleep(400)
    expect(changes).toBe(3)
    watcher.close()
    project.writeFile("skins/new/texture.svg", "later")
    await Bun.sleep(400)
    expect(changes).toBe(3)
  } finally {
    watcher.close()
    project.cleanup()
    dependency.cleanup()
  }
})
