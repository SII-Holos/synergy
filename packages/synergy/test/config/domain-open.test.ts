import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigDomainOpen } from "../../src/config/domain-open"

describe("ConfigDomainOpen", () => {
  test("resolves macOS opener", () => {
    const cmd = ConfigDomainOpen.commandForPlatform("/tmp/00-general.jsonc", "darwin", (name) => `/usr/bin/${name}`)
    expect(cmd).toEqual(["/usr/bin/open", "/tmp/00-general.jsonc"])
  })

  test("resolves Linux opener", () => {
    const cmd = ConfigDomainOpen.commandForPlatform("/tmp/00-general.jsonc", "linux", (name) => `/usr/bin/${name}`)
    expect(cmd).toEqual(["/usr/bin/xdg-open", "/tmp/00-general.jsonc"])
  })

  test("resolves Windows opener without arbitrary shell input", () => {
    const cmd = ConfigDomainOpen.commandForPlatform("C:\\Users\\test\\00-general.jsonc", "win32", () => undefined)
    expect(cmd.slice(1)).toEqual(["/c", "start", "", "C:\\Users\\test\\00-general.jsonc"])
  })

  test("throws when platform opener is missing", () => {
    expect(() => ConfigDomainOpen.commandForPlatform("/tmp/00-general.jsonc", "linux", () => undefined)).toThrow(
      ConfigDomainOpen.OpenerMissingError,
    )
  })

  test("materializes a canonical domain file only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-config-open-"))
    try {
      const filepath = await ConfigDomainOpen.materialize("general", root)
      expect(filepath.endsWith(path.join("synergy.d", "00-general.jsonc"))).toBe(true)
      expect(await Bun.file(filepath).text()).toBe("{}\n")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
