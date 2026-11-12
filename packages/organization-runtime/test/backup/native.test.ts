import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRuntimeNative as Native } from "../../src/backup/native"
import { prepareHostedHome, readHostedHome, runtimeIdentityDigest, NativeHomeReaderContract } from "../../src/home"
import { enrollHostedRuntime } from "../../src/enrollment"
import { readRuntimeRegistration } from "../../src/registration"
import { registerOrganizationNamespaceIdentity } from "../../src/namespace-identity"
import { connectionState } from "../../src/connection-state"
import { readCredentials } from "../../src/credentials"
import { fixture } from "../support/organization"
import { OrganizationBackupCohort as Cohort } from "../../../organization/src/backup/cohort"
import { OrganizationRecoveryArchive as Archive } from "../../../organization/src/backup/archive"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { ArchivedHomeReaderContract, HostedBinding } from "../../src/home-schema"

const keys = {
  async current() {
    return { version: "recovery", key: Buffer.alloc(32, 9) }
  },
  async resolve() {
    return Buffer.alloc(32, 9)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "hosted-native",
}

async function source() {
  const service = await fixture()
  try {
    const home = await prepareHostedHome({
      baseDirectory: path.join(service.root, "hosted"),
      identity: { orgID: service.identity.orgID, hostID: "native" },
      origin: service.origin,
    })
    const ticket = (
      await service.client.orgRuntime.registerHosted(
        { orgHostedRuntimeRegistration: { name: "Native", publicKey: home.publicKey } },
        { headers: service.headers, throwOnError: true },
      )
    ).data
    const registration = await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
    const runtime = await testRuntime({
      home: home.home,
      register() {
        HomeOwnership.select({
          owner: "organization-runtime",
          identity: runtimeIdentityDigest(home.identity),
          readerContract: NativeHomeReaderContract,
        })
        registerOrganizationNamespaceIdentity(home.identity)
        Native.register({ identity: home.identity, ca: service.ca })
        RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
      },
    })
    let lease: RuntimeMaintenance.Lease | undefined
    let closed = false
    const close = async () => {
      if (closed) return
      if (lease) await runtime.run(() => RuntimeMaintenance.release(lease!))
      lease = undefined
      await runtime.close()
      closed = true
    }
    return {
      home,
      registration,
      service,
      runtime,
      close,
      capture(signal?: AbortSignal, before?: () => Promise<void>) {
        return runtime.run(async () => {
          lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
          return RuntimeMaintenance.withFrozen(lease, () =>
            SnapshotMaintenance.withCapture(async (capture) => {
              const archive = await capture.exportArchive({
                directory: path.join(service.root, "records"),
                archiveID: "hosted",
                namespaceID: "hosted",
                buildVersion: "fixture",
                keys,
                protect: () => true,
              })
              const evidence = await capture.validateArchive(archive)
              await before?.()
              const native = await Native.capture({
                archive: evidence,
                lease: lease!,
                directory: path.join(service.root, "native"),
                keys,
                signal,
              })
              return { archive, native }
            }),
          )
        })
      },
      async [Symbol.asyncDispose]() {
        await close()
        await service[Symbol.asyncDispose]()
      },
    }
  } catch (error) {
    await service[Symbol.asyncDispose]()
    throw error
  }
}

test("a Hosted native segment preserves its machine key and monotonic connection checkpoint for independent cold readers", async () => {
  await using selected = await source()
  await connectionState(selected.home, selected.registration).save(selected.registration.connectionEpoch + 7)
  const captured = await selected.capture()
  const verified = await Native.verify({
    directory: captured.native.directory,
    expected: captured.native.namespace,
    source: captured.archive.namespace,
    keys,
  })
  expect(verified.connectionEpoch).toBe(selected.registration.connectionEpoch + 7)
  expect(verified.registration).toEqual(selected.registration)
  expect(verified.startup.ca).toEqual([selected.service.ca])
  const target = path.join(selected.service.root, "cold-target")
  const root = path.join(target, ".synergy")
  const roles: Record<string, string> = {
    owner: "home-ownership.json",
    binding: "organization.json",
    credentials: "auth/organization-runtime.json",
    registration: "organization-registration.json",
    connection: "organization-connection.json",
  }
  for await (const entry of StorageCheckpoint.entries({
    directory: captured.native.directory,
    expected: captured.native.namespace,
    keys,
  })) {
    if (entry.type !== "artifact") continue
    const relative = roles[entry.key[2]!]
    if (!relative) throw new Error("Unexpected native role")
    const filename = path.join(root, relative)
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    const bytes: Uint8Array[] = []
    for await (const chunk of StorageCheckpoint.streamArtifact({
      directory: captured.native.directory,
      location: entry.location,
    }))
      bytes.push(chunk)
    await fs.writeFile(filename, Buffer.concat(bytes), { mode: 0o600 })
  }
  await fs.rm(captured.archive.directory, { recursive: true })
  await fs.rm(captured.native.directory, { recursive: true })
  await selected.close()
  await fs.rm(selected.home.home, { recursive: true })
  const cold = await readHostedHome(target, selected.home.identity)
  const registration = await readRuntimeRegistration(target, selected.home.identity)
  expect(registration).toEqual(selected.registration)
  expect(await connectionState(cold, registration!).read()).toBe(verified.connectionEpoch)
  const credentials = await readCredentials(cold.root)
  const challenge = new TextEncoder().encode("independent restored machine proof")
  const signature = await crypto.subtle.sign("Ed25519", credentials!.privateKey, challenge)
  const publicKey = await crypto.subtle.importKey("raw", Buffer.from(cold.publicKey, "hex"), "Ed25519", false, [
    "verify",
  ])
  expect(await crypto.subtle.verify("Ed25519", publicKey, signature, challenge)).toBe(true)
  expect(Protocol.PublicKey.parse(cold.publicKey)).toBe(selected.home.publicKey)
})

test("Hosted native cancellation preserves a separately held connection writer and publishes no segment", async () => {
  await using selected = await source()
  const controller = new AbortController()
  const reason = new Error("original Hosted native capture cancelled")
  await withFileLock(
    { directory: path.join(selected.home.root, "state", ".locks"), key: "organization-connection" },
    async () => {
      const timer = setTimeout(() => controller.abort(reason), 40)
      try {
        await expect(selected.capture(controller.signal)).rejects.toBe(reason)
        expect(await fs.exists(path.join(selected.service.root, "native"))).toBe(false)
      } finally {
        clearTimeout(timer)
      }
    },
  )
  await connectionState(selected.home, selected.registration).save(selected.registration.connectionEpoch + 1)
  expect(await connectionState(selected.home, selected.registration).read()).toBe(
    selected.registration.connectionEpoch + 1,
  )
})

test("a Hosted native segment preserves explicit absent connection state and rejects a different fixed namespace", async () => {
  await using selected = await source()
  const captured = await selected.capture()
  const input = {
    directory: captured.native.directory,
    expected: captured.native.namespace,
    source: captured.archive.namespace,
    keys,
  }
  const manifest = await Native.verify(input)
  expect(manifest.files.connection).toBeUndefined()
  expect(manifest.connectionEpoch).toBe(selected.registration.connectionEpoch)
  await expect(
    Native.verify({ ...input, source: { ...captured.archive.namespace, archiveID: "different" } }),
  ).rejects.toThrow("another namespace")
})

test("a fixed archived Home2 prior-reader segment stays verifiable without ordinary-reader fallback", async () => {
  await using selected = await source()
  const captured = await selected.capture()
  const material = new Map<string, Uint8Array>()
  let original: Native.Manifest | undefined
  for await (const entry of StorageCheckpoint.entries({
    directory: captured.native.directory,
    expected: captured.native.namespace,
    keys,
  })) {
    if (entry.type === "record") {
      original = Native.Manifest.parse(entry.value)
      continue
    }
    if (entry.type !== "artifact" || entry.location.size > 8192) throw new Error("Invalid native fixture role")
    const bytes = new Uint8Array(entry.location.size)
    let offset = 0
    for await (const chunk of StorageCheckpoint.streamArtifact({
      directory: captured.native.directory,
      location: entry.location,
    })) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    material.set(entry.key[2]!, bytes)
  }
  if (!original) throw new Error("Native fixture metadata is missing")
  const previous = ArchivedHomeReaderContract.options[0]
  for (const role of ["owner", "binding"]) {
    const bytes = material.get(role)
    if (!bytes) throw new Error("Native fixture role is missing")
    const record = JSON.parse(Buffer.from(bytes).toString("utf8"))
    record.readerContract = previous
    material.set(role, Buffer.from(JSON.stringify(record)))
  }
  expect(HostedBinding.safeParse(JSON.parse(Buffer.from(material.get("binding")!).toString("utf8"))).success).toBe(
    false,
  )
  const directory = path.join(selected.service.root, "archived-native")
  const temporary = path.join(selected.service.root, "archive-conversion")
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "archive-conversion",
    filename: path.join(temporary, "segment.sqlite"),
  })
  try {
    const expected = await selected.runtime.run(() =>
      Storage.provide({ store, artifactDirectory: path.join(temporary, "artifacts") }, async () => {
        for (const [role, bytes] of material) await Storage.writeBinary(["runtime-native", "file", role], bytes)
        await Storage.write(
          ["runtime-native", "manifest"],
          Native.Manifest.parse({
            ...original,
            files: Object.fromEntries(
              [...material].map(([role, bytes]) => [
                role,
                { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
              ]),
            ),
          }),
        )
        return StorageCheckpoint.exportArchive({
          directory,
          archiveID: "historical-native",
          namespaceID: captured.native.namespace.namespaceID,
          buildVersion: "prior-reader-fixture",
          keys,
          protect: () => true,
        })
      }),
    )
    const historical = await Native.verify({ directory, expected, source: captured.archive.namespace, keys })
    expect(historical.registration).toEqual(selected.registration)
    expect(historical.startup).toEqual(original.startup)
    expect(historical.files.credentials).toEqual(original.files.credentials)
  } finally {
    await store.close()
  }
})

test("missing Hosted machine credentials block capture without generating a replacement identity", async () => {
  await using selected = await source()
  const filename = path.join(selected.home.root, "auth", "organization-runtime.json")
  await expect(selected.capture(undefined, () => fs.rm(filename))).rejects.toThrow("credentials are missing")
  expect(await fs.exists(filename)).toBe(false)
  expect(await fs.exists(path.join(selected.service.root, "native"))).toBe(false)
})

test("the real enrolled cohort encrypts its Hosted native segment and preserves its fixed namespace relationship", async () => {
  await using selected = await source()
  const directory = path.join(selected.service.root, "cohort")
  const report = await Cohort.capture({
    service: Cohort.service(selected.service.service.maintenance),
    async resolve() {
      return Cohort.hosted(selected.runtime, { native: Native.capture })
    },
    directory,
    archiveID: "native-cohort",
    buildVersion: "fixture",
    keys,
    actor,
  })
  expect(report.namespaceCheckpointsComplete).toBe(true)
  const outputDirectory = path.join(selected.service.root, "opened")
  await Archive.open({ directory, outputDirectory, keys })
  await fs.rm(directory, { recursive: true })
  const base = path.join(outputDirectory, "namespaces", "0000000000000001")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  expect(inventory.hostedNative).toBeDefined()
  const manifest = await Native.verify({
    directory: path.join(base, "hosted-native"),
    expected: inventory.hostedNative!,
    source: inventory.namespace,
    keys,
  })
  expect(manifest.registration.runtimeID).toBe(selected.registration.runtimeID)
})
