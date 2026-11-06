import { expect, test } from "bun:test"
import path from "node:path"
import { watchPluginSources } from "../src/lib/source-watch"
import { createFixtureProject } from "./fixtures"

test("watcher follows new asset directories and external dependencies without watching its own output", async () => {
  const project = createFixtureProject("watch-assets")
  const dependency = createFixtureProject("watch-dependency")
  let changes = 0
  let change = Promise.withResolvers<void>()
  const watcher = watchPluginSources(project.root, () => {
    changes++
    change.resolve()
  })
  try {
    dependency.writeFile("shared.ts", "export const value = 1")
    watcher.update([path.join(dependency.root, "shared.ts")])
    change = Promise.withResolvers<void>()
    project.writeFile("skins/new/texture.svg", "first")
    await change.promise
    expect(changes).toBe(1)
    change = Promise.withResolvers<void>()
    dependency.writeFile("shared.ts", "export const value = 2")
    await change.promise
    expect(changes).toBe(2)
    watcher.update([], false)
    change = Promise.withResolvers<void>()
    dependency.writeFile("shared.ts", "export const value = 3")
    await change.promise
    expect(changes).toBe(3)
    project.writeFile("dist/ui/index.js", "generated")
    project.writeFile("src/generated/plugin-data/index.d.ts", "generated")
    await Bun.sleep(400)
    expect(changes).toBe(3)
    change = Promise.withResolvers<void>()
    project.writeFile("src/index.ts", "export {}")
    await change.promise
    expect(changes).toBe(4)
    watcher.close()
    project.writeFile("skins/new/texture.svg", "later")
    await Bun.sleep(400)
    expect(changes).toBe(4)
  } finally {
    watcher.close()
    project.cleanup()
    dependency.cleanup()
  }
})

test("watcher observes the first authored file in a new source directory", async () => {
  const project = createFixtureProject("watch-new-source")
  let changes = 0
  let change = Promise.withResolvers<void>()
  const watcher = watchPluginSources(project.root, () => {
    changes++
    change.resolve()
  })
  try {
    change = Promise.withResolvers<void>()
    project.writeFile("src/index.ts", "export {}")
    await change.promise
    expect(changes).toBe(1)
  } finally {
    watcher.close()
    project.cleanup()
  }
})
