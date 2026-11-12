import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationBackupAdministration as Administration } from "../../src/backup/administration"
import { fixture, password } from "./organization"

const installed = process.env.SYNERGY_TEST_ORGANIZATION_INSTALL
const entry = installed
  ? path.join(installed, "node_modules/.bin/synergy-org")
  : path.resolve(import.meta.dir, "../../src/entry.ts")

export async function preparedFixture() {
  const source = await fixture()
  await source.initialize()
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "cli-recovery-retry-")))
  const material = randomBytes(32)
  const keyFile = path.join(root, "key.json")
  await fs.writeFile(
    keyFile,
    JSON.stringify({ version: 1, current: "retry", keys: { retry: material.toString("base64") } }),
    { mode: 0o600 },
  )
  const keys = {
    async current() {
      return { version: "retry", key: material }
    },
    async resolve(version: string) {
      if (version !== "retry") throw new Error("Wrong synthetic key version")
      return material
    },
  }
  await source.service.maintenance.run(() =>
    Storage.writeBinary(["organization", "retained-binary"], Buffer.from("original retained bytes")),
  )
  await source.service.close()
  const directory = path.join(root, "archive")
  await Administration.capture({ home: source.service.home, directory, buildVersion: "fixture", keys })
  await source.restart()
  const owner = source.client()
  await owner.login("owner", password)
  expect(
    (await owner.request("POST", "/auth/password", { currentPassword: password, password: "H1 retry password" }))
      .status,
  ).toBe(200)
  await source.service.close()
  const home = path.join(root, "target")
  const restoreID = crypto.randomUUID()
  const target = await Administration.install({ home, directory, restoreID, keys })
  const work = path.join(root, "work")
  const publicOrigin = "https://recovered.example"
  const input = {
    home,
    sourceHome: source.service.home,
    directory,
    restoreID,
    work,
    publicOrigin,
    keys,
    buildVersion: "fixture",
  }
  const materialFile = path.join(
    home,
    ".synergy",
    "state",
    "organization-recovery",
    target.installationID,
    "signing-material.json",
  )
  const materialHash = () => fs.readFile(materialFile).then((bytes) => createHash("sha256").update(bytes).digest("hex"))
  const originalKey = await materialHash()
  return {
    source,
    root,
    input,
    target,
    originalKey,
    materialHash,
    async invoke() {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--no-bunfig",
          entry,
          "recover",
          "--input",
          directory,
          "--restore-id",
          restoreID,
          "--source-home",
          input.sourceHome,
          "--work",
          work,
          "--key-file",
          keyFile,
          "--origin",
          publicOrigin,
        ],
        {
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
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    },
    async [Symbol.asyncDispose]() {
      await source[Symbol.asyncDispose]()
      material.fill(0)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
