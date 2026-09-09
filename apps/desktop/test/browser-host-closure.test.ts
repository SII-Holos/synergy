import { afterEach, expect, test } from "bun:test"
import { createPackage } from "@electron/asar"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { prepareBrowserHost } from "../script/prepare-browser-host"

const { assertBrowserHostClosure } = createRequire(import.meta.url)("../script/browser-host-after-pack.cjs") as {
  assertBrowserHostClosure(archive: string): void
}
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-browser-host-closure-"))
  directories.push(directory)
  const app = path.join(directory, "app")
  const bundle = path.join(directory, "bundle.js")
  await Bun.write(bundle, "import { app } from 'electron'; app.whenReady()")
  await prepareBrowserHost(app, bundle)
  return { directory, app, bundle, archive: path.join(directory, "app.asar") }
}

test("stages only the bundled Browser Host and an independent manifest, removing stale Desktop dependencies", async () => {
  const value = await fixture()
  await Bun.write(path.join(value.app, "node_modules/stale/index.js"), "stale")
  await prepareBrowserHost(value.app, value.bundle)
  await createPackage(value.app, value.archive)
  expect(() => assertBrowserHostClosure(value.archive)).not.toThrow()
  expect(await Bun.file(path.join(value.app, "dist/browser-host-main.js")).text()).toContain("from 'electron'")
  expect((await Bun.file(path.join(value.app, "package.json")).json()).dependencies).toEqual({})
})

for (const entry of [
  "node_modules/@ericsanchezok/synergy-harness/src/index.ts",
  "node_modules/@ericsanchezok/synergy-library/test/leak.ts",
  "node_modules/@trycua/cua-driver/driver.node",
  "coverage/lcov.info",
]) {
  test(`rejects a real asar containing unrelated payload: ${entry}`, async () => {
    const value = await fixture()
    await Bun.write(path.join(value.app, entry), "unexpected")
    await createPackage(value.app, value.archive)
    expect(() => assertBrowserHostClosure(value.archive)).toThrow("Unexpected Browser Host archive entry")
  })
}

test("rejects dependency declarations and unpacked native payloads", async () => {
  const value = await fixture()
  const manifest = await Bun.file(path.join(value.app, "package.json")).json()
  await Bun.write(
    path.join(value.app, "package.json"),
    JSON.stringify({ ...manifest, dependencies: { unwanted: "1" } }),
  )
  await createPackage(value.app, value.archive)
  expect(() => assertBrowserHostClosure(value.archive)).toThrow("without production package dependencies")
  await prepareBrowserHost(value.app, value.bundle)
  const cleanArchive = path.join(value.directory, "clean.asar")
  await createPackage(value.app, cleanArchive)
  await fs.mkdir(`${cleanArchive}.unpacked`)
  expect(() => assertBrowserHostClosure(cleanArchive)).toThrow("unpacked dependencies")
})
