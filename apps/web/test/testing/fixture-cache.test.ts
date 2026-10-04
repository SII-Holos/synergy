import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cachedFixture } from "../support/fixture-cache"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const cache = await mkdtemp(path.join(os.tmpdir(), "web-fixture-cache-"))
  roots.push(cache)
  let builds = 0
  const prepare = (input = "first") =>
    cachedFixture({
      cache,
      input,
      async build(directory) {
        builds++
        await Bun.write(path.join(directory, "index.html"), input)
        await Bun.write(path.join(directory, "assets/main.js"), `export default ${JSON.stringify(input)}`)
      },
    })
  return { cache, prepare, builds: () => builds }
}

test("identical concurrent requests publish one complete fixture and changed inputs build separately", async () => {
  const f = await fixture()
  const directories = await Promise.all([f.prepare(), f.prepare(), f.prepare()])
  expect(new Set(directories).size).toBe(1)
  expect(f.builds()).toBe(1)
  expect(await Bun.file(path.join(directories[0]!, "assets/main.js")).text()).toBe('export default "first"')
  const changed = await f.prepare("changed alias or stub")
  expect(changed).not.toBe(directories[0])
  expect(f.builds()).toBe(2)
  expect(await f.prepare()).toBe(directories[0]!)
  expect(f.builds()).toBe(2)
})

test("changed, missing and additional output bytes each invalidate a cached fixture", async () => {
  const f = await fixture()
  const directory = await f.prepare()
  await Bun.write(path.join(directory, "assets/main.js"), "stale bundle")
  await f.prepare()
  expect(f.builds()).toBe(2)
  await rm(path.join(directory, "index.html"))
  await f.prepare()
  expect(f.builds()).toBe(3)
  await Bun.write(path.join(directory, "assets/unexpected.js"), "untracked bundle")
  await f.prepare()
  expect(f.builds()).toBe(4)
  expect(await Bun.file(path.join(directory, "assets/unexpected.js")).exists()).toBe(false)
})

test("an output symlink is rejected even when its target contains the expected bytes", async () => {
  const f = await fixture()
  const directory = await f.prepare()
  const target = path.join(f.cache, "outside.js")
  await Bun.write(target, await Bun.file(path.join(directory, "assets/main.js")).arrayBuffer())
  await rm(path.join(directory, "assets/main.js"))
  await symlink(target, path.join(directory, "assets/main.js"))
  await f.prepare()
  expect(f.builds()).toBe(2)
  expect(await Bun.file(target).text()).toBe('export default "first"')
})

test("a failed build publishes nothing and a later request can recover", async () => {
  const f = await fixture()
  await expect(
    cachedFixture({
      cache: f.cache,
      input: "first",
      async build(directory) {
        await Bun.write(path.join(directory, "index.html"), "partial")
        throw new Error("fixture compiler failed")
      },
    }),
  ).rejects.toThrow("fixture compiler failed")
  expect((await readdir(f.cache)).filter((entry) => entry !== ".locks")).toEqual([])
  const directory = await f.prepare()
  expect(await Bun.file(path.join(directory, "index.html")).text()).toBe("first")
})
