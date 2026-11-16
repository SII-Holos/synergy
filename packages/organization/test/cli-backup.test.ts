import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { OrganizationRecoveryArchive } from "../src/backup/archive"
import { openOrganizationRecovery, openOrganizationService } from "../src/service"
import { fixture } from "./support/organization"

const installed = process.env.SYNERGY_TEST_ORGANIZATION_INSTALL
const entry = installed
  ? path.join(installed, "node_modules/.bin/synergy-org")
  : path.resolve(import.meta.dir, "../src/entry.ts")

async function invoke(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-bunfig", entry, ...args], {
    cwd: installed ?? process.env.SYNERGY_TEST_ROOT,
    env: {
      ...process.env,
      SYNERGY_HOME: home,
      SYNERGY_RUNTIME_ROOT: undefined,
      NODE_PATH: undefined,
      NODE_OPTIONS: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("administrative backup retains native bytes and restore imports only a recovery-held service", async () => {
  await using f = await fixture()
  await f.initialize()
  const home = f.service.home
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-backup-cli-"))
  const material = randomBytes(32)
  try {
    const keyFile = path.join(root, "keys.json")
    await fs.writeFile(
      keyFile,
      JSON.stringify({ version: 1, current: "test", keys: { test: material.toString("base64") } }),
      { mode: 0o600 },
    )
    const address = ["organization", "cli-backup-proof"]
    const bytes = Buffer.from("original private service artifact bytes")
    await f.service.maintenance.run(() => Storage.writeBinary(address, bytes))
    await f.service.close()
    const archive = path.join(root, "archive")
    const captured = await invoke(home, ["backup", "--output", archive, "--key-file", keyFile])
    expect(captured.code, captured.stderr).toBe(0)
    expect(JSON.parse(captured.stdout)).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 1 })
    const keys = {
      async current() {
        return { version: "test", key: material }
      },
      async resolve() {
        return material
      },
    }
    const verified = await OrganizationRecoveryArchive.verify({ directory: archive, keys })
    expect(verified.bytes).toBeGreaterThan(bytes.length)
    expect(await fs.readFile(path.join(archive, "archive.json"), "utf8")).not.toContain(bytes.toString())
    const originalHeader = await fs.readFile(path.join(archive, "archive.json"))
    const duplicate = await invoke(home, ["backup", "--output", archive, "--key-file", keyFile])
    expect(duplicate.code).toBe(1)
    expect(await fs.readFile(path.join(archive, "archive.json"))).toEqual(originalHeader)
    await using liveSource = await openOrganizationService({ home })
    const locked = await invoke(home, ["backup", "--output", path.join(root, "locked"), "--key-file", keyFile])
    expect(locked.code).toBe(1)
    expect(await fs.exists(path.join(root, "locked"))).toBe(false)
    expect((await liveSource.deployment()).orgID).toBeDefined()
    await liveSource.close()
    const target = path.join(root, "target")
    await fs.mkdir(target)
    const restoreID = crypto.randomUUID()
    const args = ["restore", "--input", archive, "--key-file", keyFile, "--restore-id", restoreID]
    const restored = await invoke(target, args)
    expect(restored.code, restored.stderr).toBe(0)
    const receipt = JSON.parse(restored.stdout)
    expect(receipt).toMatchObject({ state: "recovery-held", executionEnabled: false, restoreID })
    const signingFile = path.join(
      target,
      ".synergy",
      "state",
      "organization-recovery",
      receipt.installationID,
      "signing-material.json",
    )
    const signingHash = createHash("sha256")
      .update(await fs.readFile(signingFile))
      .digest("hex")
    const retried = await invoke(target, args)
    expect(retried.code, retried.stderr).toBe(0)
    expect(JSON.parse(retried.stdout)).toEqual(receipt)
    expect(
      createHash("sha256")
        .update(await fs.readFile(signingFile))
        .digest("hex"),
    ).toBe(signingHash)
    await using inspected = await openOrganizationRecovery({ home: target })
    await inspected.run(async () => {
      expect(Buffer.from(await Storage.readBinary(address))).toEqual(bytes)
      expect((await RuntimeMaintenance.status())?.phase).toBe("recovery-held")
    })
    await inspected.close()
    await expect(openOrganizationService({ home: target })).rejects.toThrow()
    expect(captured.stdout + captured.stderr + restored.stdout + restored.stderr).not.toContain(
      material.toString("base64"),
    )
  } finally {
    material.fill(0)
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("private keys and authenticated archive validation precede Home initialization", async () => {
  const root = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-backup-rejected-"))
  const material = randomBytes(32)
  try {
    const keyFile = path.join(root, "keys.json")
    const keys = { version: 1, current: "test", keys: { test: material.toString("base64") } }
    await fs.writeFile(keyFile, JSON.stringify(keys), { mode: 0o600 })
    const unowned = path.join(root, "unowned")
    await fs.mkdir(unowned)
    const output = path.join(root, "not-created")
    expect((await invoke(unowned, ["backup", "--output", output, "--key-file", keyFile])).code).toBe(1)
    expect(await fs.readdir(unowned)).toEqual([])
    expect(await fs.exists(output)).toBe(false)
    if (process.platform !== "win32") {
      await fs.chmod(keyFile, 0o644)
      expect((await invoke(unowned, ["backup", "--output", output, "--key-file", keyFile])).code).toBe(1)
      expect(await fs.readdir(unowned)).toEqual([])
      await fs.chmod(keyFile, 0o600)
    }
    const invalid = "private-invalid-recovery-content"
    await fs.writeFile(keyFile, JSON.stringify({ ...keys, keys: { test: invalid } }))
    const rejected = await invoke(unowned, ["backup", "--output", output, "--key-file", keyFile])
    expect(rejected.code).toBe(1)
    expect(rejected.stdout + rejected.stderr).not.toContain(invalid)
    expect(await fs.readdir(unowned)).toEqual([])
    await fs.writeFile(keyFile, JSON.stringify(keys))
    const archive = path.join(root, "archive")
    await OrganizationRecoveryArchive.seal({
      directory: archive,
      archiveID: crypto.randomUUID(),
      buildVersion: "fixture",
      keys: {
        async current() {
          return { version: "test", key: material }
        },
        async resolve() {
          return material
        },
      },
      files: (async function* () {})(),
    })
    const header = JSON.parse(await fs.readFile(path.join(archive, "archive.json"), "utf8"))
    header.archiveID = crypto.randomUUID()
    await fs.writeFile(path.join(archive, "archive.json"), JSON.stringify(header))
    const target = path.join(root, "untouched-target")
    const restored = await invoke(target, [
      "restore",
      "--input",
      archive,
      "--key-file",
      keyFile,
      "--restore-id",
      crypto.randomUUID(),
    ])
    expect(restored.code).toBe(1)
    expect(await fs.exists(target)).toBe(false)
    expect(restored.stdout + restored.stderr).not.toContain(material.toString("base64"))
  } finally {
    material.fill(0)
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20_000)
