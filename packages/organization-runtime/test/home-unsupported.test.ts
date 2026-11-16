import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { prepareHostedHome, readRuntimeHome } from "../src/home"
import { registerOrganizationHomeMigration, upgradeOrganizationHome } from "../src/home-migration"

test("the unpublished maintenance-only hosted format is rejected without changing files or credentials", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "native-unsupported-home-"))
  const identity = { orgID: "org", hostID: "hosted" }
  const home = await prepareHostedHome({ baseDirectory: directory, identity, origin: "https://organization.example" })
  const files = ["home-ownership.json", "organization.json"].map((name) => path.join(home.root, name))
  for (const filename of files) {
    const current = JSON.parse(await fs.readFile(filename, "utf8"))
    await fs.writeFile(filename, JSON.stringify({ ...current, readerContract: "purpose-bound-maintenance-v1" }))
  }
  const credentials = path.join(home.root, "auth", "organization-runtime.json")
  const before = await Promise.all([...files, credentials].map((filename) => fs.readFile(filename)))
  const runtime = await storageTestRuntime({ home: home.home })
  const store = await TransactionalStore.open({
    backend: "sqlite",
    filename: path.join(home.root, "authority.sqlite"),
    namespace: "unsupported-home",
  })
  try {
    await expect(readRuntimeHome(home.home, identity)).rejects.toThrow("migration")
    await runtime.run(() =>
      Storage.provide({ store, artifactDirectory: path.join(home.root, "data") }, async () => {
        RuntimeMaintenance.configure({ required: ["controlled-fixture"] })
        RuntimeMaintenance.register("controlled-fixture", {
          version: 1,
          async suspend() {},
          async drain() {},
          async inspect() {
            return []
          },
          async release() {},
        })
        registerOrganizationHomeMigration(identity)
        const requestID = "reject-maintenance-only-reader"
        const lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID,
          actor: {
            kind: "system",
            subjectID: "operator",
            displayName: "Operator",
            clientKind: "system",
            requestID,
          },
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        await expect(upgradeOrganizationHome({ home: home.home, identity, lease })).rejects.toThrow("unsupported")
        expect((await RuntimeMaintenance.status())?.phase).toBe("frozen")
      }),
    )
    expect(await Promise.all([...files, credentials].map((filename) => fs.readFile(filename)))).toEqual(before)
  } finally {
    await store.close()
    await runtime.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
