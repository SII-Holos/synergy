import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DaemonState } from "../../src/daemon/state"
import { DaemonPaths } from "../../src/daemon/paths"

const originalTestHome = process.env.SYNERGY_TEST_HOME

describe("daemon.state", () => {
  let home: string

  beforeEach(async () => {
    home = path.join(os.tmpdir(), `synergy-daemon-${Math.random().toString(36).slice(2)}`)
    process.env.SYNERGY_TEST_HOME = home
    await fs.mkdir(home, { recursive: true })
  })

  afterEach(async () => {
    if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalTestHome
    await fs.rm(home, { recursive: true, force: true })
  })

  test("writes and reads manifest", async () => {
    await DaemonState.writeManifest({
      label: "dev.synergy.server",
      manager: "launchd",
      hostname: "0.0.0.0",
      connectHostname: "127.0.0.1",
      port: 4096,
      url: "http://127.0.0.1:4096",
      mdns: true,
      cors: ["https://allowed.example"],
      command: ["synergy", "server"],
      cwd: home,
      logFile: DaemonPaths.logFile(),
      env: { SYNERGY_DAEMON: "1" },
      lastStartedAt: 123,
    })

    const manifest = await DaemonState.readManifest()
    expect(manifest?.label).toBe("dev.synergy.server")
    expect(manifest?.manager).toBe("launchd")
    expect(manifest?.port).toBe(4096)
    expect(manifest?.lastStartedAt).toBe(123)
  })
})
