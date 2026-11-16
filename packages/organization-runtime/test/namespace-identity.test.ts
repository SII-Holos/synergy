import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { OrganizationBackupCohort as Cohort } from "../../organization/src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../organization/src/backup/archive"
import { prepareHostedHome, runtimeIdentityDigest, NativeHomeReaderContract } from "../src/home"
import { enrollHostedRuntime } from "../src/enrollment"
import { readRuntimeRegistration, registrationFilename } from "../src/registration"
import { registerOrganizationNamespaceIdentity } from "../src/namespace-identity"
import { openHostedRuntime } from "../src/runtime"
import { fixture } from "./support/organization"

const actor = {
  kind: "system" as const,
  subjectID: "host-operator",
  displayName: "Host operator",
  clientKind: "system" as const,
  requestID: "cohort",
}

async function enrolled(service: Awaited<ReturnType<typeof fixture>>, hostID: string) {
  const home = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID },
    origin: service.origin,
  })
  const ticket = (
    await service.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: hostID, publicKey: home.publicKey } },
      { headers: service.headers, throwOnError: true },
    )
  ).data
  const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
  expect(await readRuntimeRegistration(home.home, home.identity)).toEqual(registration)
  return { home, registration }
}

function native(home: Awaited<ReturnType<typeof prepareHostedHome>>) {
  return testRuntime({
    home: home.home,
    register() {
      HomeOwnership.select({
        owner: "organization-runtime",
        identity: runtimeIdentityDigest(home.identity),
        readerContract: NativeHomeReaderContract,
      })
      registerOrganizationNamespaceIdentity(home.identity)
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
    },
  })
}

test("cohort validates actual enrolled Hosted Home identity instead of an operator-supplied registration label", async () => {
  await using serviceA = await fixture()
  await using serviceB = await fixture()
  const a = await enrolled(serviceA, "required-a")
  const b = await enrolled(serviceB, "foreign-b")
  expect(a.registration.orgID).not.toBe(b.registration.orgID)
  await using runtimeB = await native(b.home)
  await runtimeB.run(() => Storage.write(["cohort-body"], { origin: "foreign-home" }))
  const material = randomBytes(32)
  const keys = {
    async current() {
      return { version: "cohort", key: material }
    },
    async resolve() {
      return material
    },
  }
  const destination = path.join(serviceA.root, "cohort")
  const input = {
    service: Cohort.service(serviceA.service.maintenance),
    async resolve() {
      return Cohort.hosted(runtimeB)
    },
    directory: destination,
    archiveID: "real-enrollment",
    buildVersion: "fixture",
    keys,
    actor,
  }
  await expect(Cohort.capture(input)).rejects.toThrow("canonical service registration")
  expect(await fs.exists(destination)).toBe(false)
  await runtimeB.run(async () => {
    expect(await RuntimeMaintenance.status()).toBeUndefined()
  })
  await using runtimeA = await native(a.home)
  await runtimeA.run(() => Storage.write(["cohort-body"], { origin: "correct-home" }))
  const report = await Cohort.capture({
    ...input,
    async resolve() {
      return Cohort.hosted(runtimeA)
    },
  })
  expect(report).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 2 })
  const opened = path.join(serviceA.root, "cohort-opened")
  await Archive.open({ directory: destination, outputDirectory: opened, keys })
  const base = path.join(opened, "namespaces", "0000000000000001")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  expect(inventory.identity).toMatchObject({
    kind: "hosted",
    orgID: a.registration.orgID,
    runtimeID: a.registration.runtimeID,
  })
  let body: unknown
  for await (const entry of StorageCheckpoint.entries({
    directory: path.join(base, "records"),
    expected: inventory.namespace,
    keys,
  }))
    if (entry.type === "record" && JSON.stringify(entry.key) === JSON.stringify(["cohort-body"])) body = entry.value
  expect(body).toEqual({ origin: "correct-home" })
  material.fill(0)
})

test("production composition installs owning identity readers and cold validation reopens only the same enrolled Home", async () => {
  await using service = await fixture()
  const selected = await enrolled(service, "same-home")
  const runtime = await openHostedRuntime({
    home: selected.home.home,
    identity: selected.home.identity,
    ca: service.ca,
  })
  const evidence = await runtime.run(() => NativeNamespaceIdentity.capture())
  await runtime.run(async () => {
    expect(NativeNamespaceIdentity.inspect(evidence)).toEqual({
      owner: "organization-runtime",
      identity: {
        kind: "hosted",
        orgID: selected.registration.orgID,
        deploymentIncarnation: selected.registration.deploymentIncarnation,
        runtimeID: selected.registration.runtimeID,
        publicKey: selected.registration.publicKey,
      },
    })
    await NativeNamespaceIdentity.verify(evidence)
  })
  await runtime.close()
  await using reopened = await openHostedRuntime({
    home: selected.home.home,
    identity: selected.home.identity,
    ca: service.ca,
  })
  await reopened.run(async () => {
    await expect(NativeNamespaceIdentity.verify(evidence)).rejects.toThrow("original")
    const fresh = await NativeNamespaceIdentity.capture()
    await NativeNamespaceIdentity.verify(fresh)
    const filename = registrationFilename(selected.home.root)
    const original = await Bun.file(filename).text()
    try {
      await Bun.write(
        filename,
        JSON.stringify({ schemaVersion: 1, registration: { ...selected.registration, runtimeID: "changed-runtime" } }),
      )
      await expect(NativeNamespaceIdentity.verify(fresh)).rejects.toThrow("identity changed")
    } finally {
      await Bun.write(filename, original)
    }
    const owner = path.join(selected.home.root, "home-ownership.json")
    const originalOwner = await Bun.file(owner).text()
    try {
      const changed = HomeOwnership.Info.parse(JSON.parse(originalOwner))
      if (changed.schemaVersion !== 2) throw new Error("Expected the native Home reader fence")
      await Bun.write(owner, JSON.stringify({ ...changed, readerContract: "unsupported-reader" }))
      await expect(NativeNamespaceIdentity.capture()).rejects.toThrow("migration")
    } finally {
      await Bun.write(owner, originalOwner)
    }
  })
})
