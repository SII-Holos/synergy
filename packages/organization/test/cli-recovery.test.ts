import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { openOrganizationService } from "../src/service"
import { fixture, password } from "./support/organization"

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
    timeout: 30_000,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test("explicit recover publishes fixed current service authority and exact retries preserve its original key", async () => {
  await using source = await fixture()
  await source.initialize()
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "cli-current-recovery-")))
  const key = randomBytes(32)
  try {
    const keyFile = path.join(root, "keys.json")
    await fs.writeFile(
      keyFile,
      JSON.stringify({ version: 1, current: "test", keys: { test: key.toString("base64") } }),
      { mode: 0o600 },
    )
    const address = ["organization", "cli-current-proof"]
    const payload = Buffer.from("original service-only private bytes")
    await source.service.maintenance.run(() => Storage.writeBinary(address, payload))
    await source.service.close()
    const input = path.join(root, "h0")
    const backup = await invoke(source.service.home, ["backup", "--output", input, "--key-file", keyFile])
    expect(backup.code, backup.stderr).toBe(0)
    await source.restart()
    const owner = source.client()
    await owner.login("owner", password)
    const currentPassword = "new current password after H0"
    expect(
      (await owner.request("POST", "/auth/password", { currentPassword: password, password: currentPassword })).status,
    ).toBe(200)
    await source.service.close()
    const target = path.join(root, "target")
    await fs.mkdir(target)
    const restoreID = crypto.randomUUID()
    const restored = await invoke(target, [
      "restore",
      "--input",
      input,
      "--key-file",
      keyFile,
      "--restore-id",
      restoreID,
    ])
    expect(restored.code, restored.stderr).toBe(0)
    const held = JSON.parse(restored.stdout)
    expect(held).toMatchObject({ state: "recovery-held", executionEnabled: false })
    const materialFile = path.join(
      target,
      ".synergy",
      "state",
      "organization-recovery",
      held.installationID,
      "signing-material.json",
    )
    const materialHash = () =>
      fs.readFile(materialFile).then((bytes) => createHash("sha256").update(bytes).digest("hex"))
    const originalKey = await materialHash()
    const args = [
      "recover",
      "--input",
      input,
      "--key-file",
      keyFile,
      "--restore-id",
      restoreID,
      "--source-home",
      source.service.home,
      "--work",
      path.join(root, "work"),
      "--origin",
      "https://recovered.example",
    ]
    const recovered = await invoke(target, args)
    expect(recovered.code, recovered.stderr).toBe(0)
    const ready = JSON.parse(recovered.stdout)
    expect(ready).toMatchObject({
      state: "ready",
      executionEnabled: false,
      restoreID,
      installationID: held.installationID,
      incarnation: held.incarnation,
    })
    expect(await materialHash()).toBe(originalKey)
    const sourceOwner = HomeOwnershipFile.RetirementInfo.parse(
      await Bun.file(path.join(source.service.home, ".synergy", "home-ownership.json")).json(),
    )
    expect(sourceOwner.schemaVersion).toBe(4)
    await using ordinary = await openOrganizationService({ home: target })
    expect((await ordinary.fetch(new Request("https://recovered.example/org/v1/ready"))).status).toBe(200)
    expect(Buffer.from(await ordinary.maintenance.run(() => Storage.readBinary(address)))).toEqual(payload)
    const login = (secret: string) =>
      ordinary.fetch(
        new Request("https://recovered.example/org/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://recovered.example" },
          body: JSON.stringify({ loginName: "owner", password: secret }),
        }),
      )
    expect((await login(password)).status).toBe(401)
    expect((await login(currentPassword)).status).toBe(200)
    await ordinary.close()
    const retried = await invoke(target, args)
    expect(retried.code, retried.stderr).toBe(0)
    expect(JSON.parse(retried.stdout)).toEqual(ready)
    expect(await materialHash()).toBe(originalKey)
    expect(recovered.stdout + recovered.stderr + retried.stdout + retried.stderr).not.toContain(key.toString("base64"))
  } finally {
    key.fill(0)
    await fs.rm(root, { recursive: true, force: true })
  }
}, 40_000)
