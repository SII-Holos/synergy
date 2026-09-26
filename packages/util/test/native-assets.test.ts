import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { nativeAsset, nativePackageName } from "../src/native-assets"

test("native package identity includes the Linux ABI and resolves from its owning module", async () => {
  expect(nativePackageName({ platform: "linux", arch: "arm64", libc: "musl" })).toBe(
    "@ericsanchezok/synergy-native-linux-arm64-musl",
  )
  expect(nativePackageName({ platform: "darwin", arch: "x64" })).toBe("@ericsanchezok/synergy-native-darwin-x64")
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synergy-native-assets-")))
  try {
    const name = nativePackageName()
    const pkg = path.join(directory, "node_modules", name)
    await Bun.write(path.join(pkg, "package.json"), JSON.stringify({ name, exports: { "./*": "./*" } }))
    await Bun.write(path.join(pkg, "fixture.bin"), "native fixture")
    const owner = pathToFileURL(path.join(directory, "owner.js"))
    expect(nativeAsset("fixture.bin", owner)).toBe(path.join(pkg, "fixture.bin"))
    expect(nativeAsset("missing.bin", owner)).toBeUndefined()
    expect(() => nativeAsset("../escape", owner)).toThrow()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
