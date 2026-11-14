import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { openOrganizationRecovery, openOrganizationService } from "../src/service"
import { OrganizationStoragePath as Keys } from "../src/storage/path"

const request = {
  restoreID: "service-restore",
  owner: "organization",
  sourceHash: "a".repeat(64),
  payload: { namespaceID: "service", recordsHash: "b".repeat(64) },
}
async function home() {
  return fs.realpath(await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "service-recovery-")))
}

test("restricted recovery opens an empty namespace without initialization or public authority and fences ordinary startup", async () => {
  const targetHome = await home()
  let incarnation = ""
  try {
    const recovery = await openOrganizationRecovery({ home: targetHome })
    try {
      expect("fetch" in recovery).toBe(false)
      expect("bootstrapToken" in recovery).toBe(false)
      expect("websocket" in recovery).toBe(false)
      await recovery.run(async () => {
        expect(RuntimeContext.isReady()).toBe(false)
        expect(await Storage.queryKeys({ prefix: [], limit: 1 })).toEqual([])
        const target = await HomeRestoration.begin(request)
        incarnation = (await HomeRestoration.inspect(target)).incarnation
      })
    } finally {
      await recovery.close()
    }
    const opened = spyOn(TransactionalStore, "open")
    try {
      await expect(openOrganizationService({ home: targetHome })).rejects.toThrow("restoration")
      expect(opened).toHaveBeenCalledTimes(0)
    } finally {
      opened.mockRestore()
    }
    const resumed = await openOrganizationRecovery({ home: targetHome })
    try {
      await resumed.run(async () => {
        const target = await HomeRestoration.begin(request)
        expect((await HomeRestoration.inspect(target)).incarnation).toBe(incarnation)
        expect(await Storage.readMany([Keys.deployment(), Keys.signingIdentity()])).toEqual([undefined, undefined])
      })
    } finally {
      await resumed.close()
    }
  } finally {
    await fs.rm(targetHome, { recursive: true, force: true })
  }
})

test("restricted recovery leaves imported old signing material inert and does not run application migrations", async () => {
  const targetHome = await home()
  const original = { schemaVersion: 2, deploymentIncarnation: "old", pkcs8: "invalid-source-material" }
  try {
    const prepare = await openOrganizationRecovery({ home: targetHome })
    try {
      await prepare.run(() => Storage.write(Keys.signingIdentity(), original))
    } finally {
      await prepare.close()
    }
    const reader = await openOrganizationRecovery({ home: targetHome })
    try {
      await reader.run(async () => {
        expect(await Storage.read(Keys.signingIdentity())).toEqual(original)
        expect(await Storage.readMany([Keys.deployment(), ["organization", "bootstrap"]])).toEqual([
          undefined,
          undefined,
        ])
        expect(RuntimeContext.isReady()).toBe(false)
      })
      expect("fetch" in reader).toBe(false)
    } finally {
      await reader.close()
    }
  } finally {
    await fs.rm(targetHome, { recursive: true, force: true })
  }
})

test("closing the restricted recovery owner rejects new callbacks and drains the original accepted callback", async () => {
  const targetHome = await home()
  const recovery = await openOrganizationRecovery({ home: targetHome })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let settled = false
  const accepted = recovery.run(async () => {
    entered.resolve()
    await release.promise
    expect(RuntimeContext.current().host.home).toBe(targetHome)
  })
  await entered.promise
  const closing = recovery.close().then(() => {
    settled = true
  })
  try {
    await expect(recovery.run(async () => {})).rejects.toThrow("closed")
    expect(settled).toBe(false)
  } finally {
    release.resolve()
    await accepted
    await closing
    await fs.rm(targetHome, { recursive: true, force: true })
  }
})
