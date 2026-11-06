import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sha256File } from "../../../packages/plugin-host/src/installation/files"
import { DESKTOP_UPGRADE_RECEIPT } from "../../../script/release/shared/desktop-app-package"
import { verifyDesktopUpgrade } from "../../../script/release/verify-desktop-upgrade"

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "desktop-upgrade-test-")))
  const version = "3.1.0"
  const file = `Synergy-darwin-arm64-${version}.zip`
  const archive = path.join(directory, file)
  const output = path.join(directory, DESKTOP_UPGRADE_RECEIPT)
  const source = path.join(directory, "source/Synergy.app/Contents")
  try {
    await mkdir(path.join(source, "MacOS"), { recursive: true })
    await mkdir(path.join(source, "Resources/synergy/bin"), { recursive: true })
    await Bun.write(path.join(source, "MacOS/Synergy"), "signed application bytes")
    await Bun.write(path.join(source, "Resources/synergy/package.json"), JSON.stringify({ version }))
    await Bun.write(path.join(source, "Resources/synergy/bin/synergy"), "#!/bin/sh\nexit 0\n")
    await chmod(path.join(source, "Resources/synergy/bin/synergy"), 0o755)
    await symlink("Resources", path.join(source, "SharedResources"))
    const zip = Bun.spawn(["zip", "-qry", archive, "Synergy.app"], {
      cwd: path.join(directory, "source"),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([zip.exited, new Response(zip.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    return {
      directory,
      archive,
      output,
      version,
      file,
      input: { directory, version, teamID: "ABCDEFGHIJ", junit: path.join(directory, "upgrade.xml") },
      [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test("the final archive is unpacked, verified before and after upgrade, then bound to successful evidence", async () => {
  await using run = await fixture()
  const stages: string[] = []
  let extracted = ""
  const receipt = await verifyDesktopUpgrade(run.input, {
    async signature(executable, identity) {
      expect(await Bun.file(executable).text()).toBe("signed application bytes")
      expect(identity.signing).toEqual({ type: "apple", teamID: "ABCDEFGHIJ" })
      expect(await readlink(path.join(path.dirname(executable), "../SharedResources"))).toBe("Resources")
      expect(await Bun.file(run.output).exists()).toBe(false)
      stages.push("signature")
    },
    async upgrade(input) {
      extracted = input.candidate
      expect(extracted.startsWith(run.directory)).toBe(false)
      expect(await Bun.file(path.join(extracted, "package.json")).json()).toEqual({ version: run.version })
      expect(input.version).toBe(run.version)
      expect(input.junit).toBe(run.input.junit)
      expect(await Bun.file(run.output).exists()).toBe(false)
      stages.push("upgrade")
    },
  })
  expect(stages).toEqual(["signature", "upgrade", "signature"])
  expect(receipt).toEqual({
    version: run.version,
    previousVersion: "3.0.22",
    target: "darwin-arm64",
    artifact: run.file,
    sha256: await sha256File(run.archive),
  })
  expect(await Bun.file(run.output).json()).toEqual(receipt)
  expect(await Bun.file(path.join(extracted, "package.json")).exists()).toBe(false)
})

test.each(["signature", "upgrade", "reseal", "archive"])(
  "%s failure removes stale evidence and cannot authorize publication",
  async (failure) => {
    await using run = await fixture()
    await Bun.write(run.output, "stale success")
    await Bun.write(run.input.junit, "stale JUnit")
    let signatures = 0
    let upgrades = 0
    let executable = ""
    await expect(
      verifyDesktopUpgrade(run.input, {
        async signature(value) {
          executable = value
          signatures++
          if (failure === "signature" || (failure === "reseal" && signatures === 2))
            throw new Error("invalid signature")
        },
        async upgrade() {
          upgrades++
          if (failure === "upgrade") throw new Error("retained history changed")
          if (failure === "archive") await Bun.write(run.archive, "replaced after acceptance")
        },
      }),
    ).rejects.toThrow()
    expect(upgrades).toBe(failure === "signature" ? 0 : 1)
    expect(await Bun.file(run.output).exists()).toBe(false)
    expect(await Bun.file(run.input.junit).exists()).toBe(false)
    expect(await Bun.file(executable).exists()).toBe(false)
  },
)
