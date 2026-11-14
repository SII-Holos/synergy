import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../src/storage/records"
import { OrganizationStoragePath as Keys } from "../src/storage/path"
import { initializeSigningIdentity, loadSigningAuthority } from "../src/signing"
import { openOrganizationService, openOrganizationServiceHomeUpgrade } from "../src/service"
import { digest } from "../src/auth/secret"
import { directoryFixture } from "./support/session-directory"

async function homes() {
  const resources = testResources()
  const home = await fs.mkdtemp(path.join(process.env.SYNERGY_TEST_ROOT!, "organization-signing-"))
  resources.defer("signing fixture Home", () => fs.rm(home, { recursive: true, force: true }))
  return {
    home,
    async open() {
      const service = await openOrganizationService({ home })
      resources.defer("signing fixture service", () => service.close())
      return service
    },
    async database<T>(body: (store: TransactionalStore) => Promise<T>) {
      const filename = path.join(home, ".synergy", "data", "organization.sqlite")
      await fs.mkdir(path.dirname(filename), { recursive: true })
      const store = await TransactionalStore.open({ backend: "sqlite", namespace: "organization", filename })
      try {
        return await body(store)
      } finally {
        await store.close()
      }
    },
    [Symbol.asyncDispose]: resources.close,
  }
}

test("the central signing migration upgrades the prior service ledger without replacing deployment identity", async () => {
  await using f = await homes()
  const deployment = {
    schemaVersion: 1 as const,
    orgID: "existing-org",
    deploymentIncarnation: "existing-deployment",
    createdAt: 1,
  }
  const previousLedger = { "20261108-organization-deployment": 1, "20261108-organization-home-ownership": 2 }
  await f.database(async (store) => {
    await store.write(Keys.deployment(), deployment)
    await store.write(StoragePath.metaMigrationLogDomain("organization"), previousLedger)
  })
  await HomeOwnershipFile.open({
    root: path.join(f.home, ".synergy"),
    env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME },
    selected: { schemaVersion: 1, owner: "organization", identity: digest("synergy.organization.service.v1") },
  }).persist()
  await using native = await openOrganizationServiceHomeUpgrade({ home: f.home })
  const lease = await native.maintenance.run(async () => {
    const selected = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "upgrade-signing-home",
      actor: {
        kind: "system",
        subjectID: "host-operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID: "upgrade-signing-home",
      },
    })
    await RuntimeMaintenance.freeze(selected, await RuntimeMaintenance.drain(selected))
    return selected
  })
  await native.upgrade({ lease })
  await native.maintenance.run(() => RuntimeMaintenance.release(lease))
  await native.close()
  const upgraded = await f.open()
  expect(await upgraded.deployment()).toEqual(deployment)
  await upgraded.close()
  const first = await f.database(async (store) => {
    const ledger = await store.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("organization"))
    expect(ledger).toMatchObject(previousLedger)
    expect(ledger?.["20261109-organization-signing-identity"]).toBeGreaterThan(2)
    return Record.SigningIdentity.parse(await store.read(Keys.signingIdentity()))
  })
  expect(first.orgID).toBe(deployment.orgID)
  const reopened = await f.open()
  await reopened.close()
  expect(await f.database((store) => store.read(Keys.signingIdentity()))).toEqual(first)
  await f.database((store) =>
    store.update<Record<string, number>>(StoragePath.metaMigrationLogDomain("organization"), (ledger) => {
      delete ledger["20261109-organization-signing-identity"]
    }),
  )
  const retried = await f.open()
  await retried.close()
  expect(await f.database((store) => store.read(Keys.signingIdentity()))).toEqual(first)
})

test("missing, damaged or foreign signing authority cannot silently regenerate after migration", async () => {
  await using f = await homes()
  const service = await f.open()
  await service.close()
  const original = await f.database(async (store) =>
    Record.SigningIdentity.parse(await store.read(Keys.signingIdentity())),
  )
  for (const value of [
    undefined,
    { ...original, pkcs8: "00" },
    { ...original, publicKey: "0".repeat(64) },
    { ...original, deploymentIncarnation: "another" },
    { ...original, schemaVersion: 3 },
  ]) {
    await f.database(async (store) => {
      if (value) await store.write(Keys.signingIdentity(), value)
      else await store.remove(Keys.signingIdentity())
    })
    await expect(f.open()).rejects.toThrow(/signing/)
    expect(await f.database(async (store) => (await store.readMany([Keys.signingIdentity()]))[0])).toEqual(value)
  }
  await f.database((store) => store.write(Keys.signingIdentity(), original))
  const restored = await f.open()
  expect((await restored.deployment()).orgID).toBe(original.orgID)
})

test("service signatures retain a detached permit and reject another authority or expired window", async () => {
  await using f = await directoryFixture()
  await f.run(async () => {
    const deployment = { schemaVersion: 1 as const, orgID: "org", deploymentIncarnation: "deployment", createdAt: 1 }
    await Storage.write(Keys.deployment(), deployment)
    await initializeSigningIdentity()
    const signer = await loadSigningAuthority(deployment)
    const now = Date.now()
    const { publicKey: _, ...identity } = signer.identity
    const claims: Command.Permit = {
      ...identity,
      purpose: "session-command",
      requestID: "request",
      payloadHash: "a".repeat(64),
      sessionID: "session",
      projectID: "project",
      runtimeID: "runtime",
      bindingEpoch: 1,
      connectionEpoch: 1,
      commandSeq: 1,
      shareGeneration: 0,
      controlRevision: 0,
      authRevision: 1,
      admissionID: "admission",
      attemptID: "attempt",
      actor: {
        kind: "account",
        orgID: "org",
        subjectID: "alice",
        requestID: "request",
        displayName: "Alice",
        clientKind: "web",
      },
      operation: "input",
      authorizedAt: now,
      deadline: now + 30_000,
    }
    const originalName = claims.actor.displayName
    const pending = signer.sign(claims)
    claims.actor.displayName = "Mutated after signing began"
    const signed = await pending
    expect(signed.permit.actor.displayName).toBe(originalName)
    expect(await Command.verify(signed.permit, signed.signature, signer.identity.publicKey)).toBe(true)
    expect(JSON.stringify(signer.identity)).not.toContain("pkcs8")
    for (const change of [
      { orgID: "other", actor: { ...claims.actor, orgID: "other" } },
      { deploymentIncarnation: "other" },
      { keyID: "other" },
      { authorizedAt: now + 10_000, deadline: now + 20_000 },
      { authorizedAt: now - 2000, deadline: now - 1000 },
    ])
      await expect(signer.sign({ ...claims, ...change })).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    await initializeSigningIdentity()
    expect((await loadSigningAuthority(deployment)).identity).toEqual(signer.identity)
  })
})
