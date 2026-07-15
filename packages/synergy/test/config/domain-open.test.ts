import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ConfigDomainOpen } from "../../src/config/domain-open"
import { domainOpenError } from "../../src/server/config-route"

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

  test("returns the config path when the platform opener is missing", () => {
    const filepath = "/tmp/00-general.jsonc"
    expect(() => ConfigDomainOpen.commandForPlatform(filepath, "linux", () => undefined)).toThrow(
      ConfigDomainOpen.OpenerMissingError,
    )

    const result = domainOpenError(new ConfigDomainOpen.OpenerMissingError(filepath, "xdg-open"))
    expect(result).toEqual({
      status: 500,
      body: {
        success: false,
        error: "ConfigDomainOpenOpenerMissingError",
        message: 'Required opener "xdg-open" was not found',
        path: filepath,
      },
    })
  })

  test("returns the config path for unsupported platforms", () => {
    const filepath = "/tmp/00-general.jsonc"
    const result = domainOpenError(new ConfigDomainOpen.UnsupportedPlatformError(filepath, "freebsd"))
    expect(result.status).toBe(400)
    expect(result.body.path).toBe(filepath)
  })

  test("returns the config path when the opener command fails", () => {
    const filepath = "/tmp/00-general.jsonc"
    const result = domainOpenError(new ConfigDomainOpen.OpenFailedError(filepath, 1, "editor unavailable"))
    expect(result.status).toBe(500)
    expect(result.body.path).toBe(filepath)
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
