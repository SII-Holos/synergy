import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, rm } from "node:fs/promises"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { findBundledBwrap, sourceLinuxHelperPath } from "../../src/sandbox/linux"
import { findHelperBinary } from "../../src/sandbox/windows"

test("bundled Bubblewrap discovery uses the isolated runtime home", async () => {
  const directory = path.join(Global.Path.root, "sandbox-helper", "bwrap")
  const binary = path.join(directory, "bwrap")
  expect(await Bun.file(binary).exists()).toBe(false)
  await mkdir(directory, { recursive: true })
  try {
    await Bun.write(binary, Buffer.alloc(60_000))
    expect(findBundledBwrap()?.path).toBe(binary)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Windows helper discovery uses the isolated runtime home", () => {
  const searched: string[] = []
  findHelperBinary([
    (home) => {
      searched.push(home)
      return path.join(home, "missing-test-helper.exe")
    },
  ])
  expect(searched).toEqual([Global.Path.home])
})

test("source Linux helper belongs to the current Rust package", async () => {
  const source = path.resolve(path.dirname(sourceLinuxHelperPath()), "../..")
  const manifest = Bun.file(path.join(source, "Cargo.toml"))
  expect(await manifest.exists()).toBe(true)
  expect(await manifest.text()).toContain('name = "synergy-sandbox-linux"')
})
