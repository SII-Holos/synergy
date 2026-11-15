import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { openOrganizationRecovery, openOrganizationService } from "@ericsanchezok/synergy-organization/service"
import {
  OrganizationRecovery,
  OrganizationCurrentAuthority,
  OrganizationSourceRetirement,
  OrganizationRecoveryPublication,
  OrganizationServiceNative,
  OrganizationRecoveryAuthority,
} from "@ericsanchezok/synergy-organization/backup/recovery"
import { cert, key as certificateKey } from "@ericsanchezok/synergy-testing/organization-tls"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ResourceHost } from "@ericsanchezok/synergy-harness/resources/host"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHostedRecovery, openHostedRecovery, openHostedSourceRetirement } from "../../src/backup/recovery"
import { OrganizationRuntimeNative as Native } from "../../src/backup/native"
import { prepareHostedHome, readHostedHome, runtimeIdentityDigest, NativeHomeReaderContract } from "../../src/home"
import { enrollHostedRuntime } from "../../src/enrollment"
import { readRuntimeRegistration } from "../../src/registration"
import { registerOrganizationNamespaceIdentity } from "../../src/namespace-identity"
import { connectionState } from "../../src/connection-state"
import { readCredentials } from "../../src/credentials"
import { fixture } from "../support/organization"
import {
  completedHostedTask,
  pausedHostedTask,
  appendCompletedHostedTask,
  verifyCompletedTaskHistory,
} from "../support/hosted-task"
import { openHostedRuntime } from "../../src/runtime"
import {
  OrganizationBackupCohort as Cohort,
  OrganizationRecoveryArchive as Archive,
} from "@ericsanchezok/synergy-organization/backup"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { HostedBinding } from "../../src/home-schema"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { OrganizationExecutionLeases } from "../../src/execution-leases"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { publishArtifactHistory, verifyArtifactHistory } from "../support/artifact-history"

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

async function openHostedFixture(input: Parameters<typeof openHostedRuntime>[0]) {
  const home = path.resolve(input.home)
  const resources: ResourceHost.Source = {
    async sample() {
      return {
        sampledAt: Date.now(),
        quality: "complete",
        pressure: "normal",
        domains: [{ kind: "physical", capacityBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }],
        processRssBytes: 0,
      }
    },
  }
  const runtime = await (async () => {
    const compose = RuntimeComponents.compose
    using configured = spyOn(RuntimeComponents, "compose").mockImplementation((...args) => {
      const composition = compose(...args)
      let installed = false
      return {
        ...composition,
        register() {
          if (!installed && RuntimeContext.current().host.home === home) {
            ResourceHost.register(resources)
            installed = true
          }
          composition.register()
        },
      }
    })
    return await openHostedRuntime(input)
  })()
  if (!(await runtime.run(async () => ResourceHost.get() === resources))) {
    await runtime.close()
    throw new Error("The original Hosted fixture did not register its selected resource observations")
  }
  return runtime
}

async function source(production = false, withTask = false) {
  const service = await fixture(production && withTask ? { connections: { heartbeatMs: 25 } } : {})
  const workspaceCoordinator = new WorkspaceCoordinator({ directory: path.join(service.root, "native-coordination") })
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
    const observedAt = Date.now()
    const connectionCloses: Array<{
      code: number
      reason: "rejected" | "registration_revoked" | "account_removed" | "other"
      observedAt: number
      readyState: number
      pendingFrames: number
      pendingBytes: number
      epoch: number
      elapsedMs: number
      leaseRemainingMs: number
    }> = []
    let connectionCloseCount = 0
    if (production)
      service.observeClose((value) => {
        if (value.runtimeID !== registration.runtimeID) return
        connectionCloseCount++
        if (connectionCloses.length === 8) connectionCloses.shift()
        connectionCloses.push({
          code: value.code,
          reason:
            value.reason === "Runtime connection rejected"
              ? "rejected"
              : value.reason === "Runtime registration revoked"
                ? "registration_revoked"
                : value.reason === "Organization account removed"
                  ? "account_removed"
                  : "other",
          observedAt: value.wallTimeMs,
          readyState: value.readyState,
          pendingFrames: value.pendingFrames,
          pendingBytes: value.pendingBytes,
          epoch: value.epoch,
          elapsedMs: value.wallTimeMs - observedAt,
          leaseRemainingMs: value.leaseRemainingMs,
        })
      })
    const listener = production ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }) : undefined
    const port = listener?.port
    await listener?.stop(true)
    const connected = Promise.withResolvers<void>()
    if (production)
      service.interceptFrames((_socket, frame) => {
        if (Protocol.ClientFrame.parse(JSON.parse(String(frame))).type === "heartbeat") connected.resolve()
        return false
      })
    const runtime = production
      ? await openHostedFixture({
          home: home.home,
          identity: home.identity,
          ca: service.ca,
          workspaceCoordinator,
          ...(port ? { listen: { port, token: "f".repeat(64) } } : {}),
        })
      : await testRuntime({
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
    if (production) {
      const timer = setTimeout(() => connected.reject(new Error("Original Hosted writer did not connect")), 3000)
      try {
        await connected.promise
      } catch (error) {
        await runtime.close()
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
    let lease: RuntimeMaintenance.Lease | undefined
    let closed = false
    const releaseCapture = async () => {
      const active = lease
      if (!active) return
      await runtime.run(async () => {
        if (!(await RuntimeMaintenance.retirement(active.maintenanceID))) await RuntimeMaintenance.release(active)
      })
      lease = undefined
    }
    const close = async () => {
      if (closed) return
      await releaseCapture()
      await runtime.close()
      closed = true
    }
    return {
      home,
      registration,
      service,
      runtime,
      workspaceCoordinator,
      connectionObservation() {
        return { connectionCloseCount, connectionCloses: connectionCloses.map((value) => ({ ...value })) }
      },
      close,
      releaseCapture,
      capture(
        signal?: AbortSignal,
        before?: () => Promise<void>,
        after?: (input: {
          archive: SnapshotMaintenance.ArchiveEvidence
          native: Awaited<ReturnType<typeof Native.capture>>
          lease: RuntimeMaintenance.Lease
          segment: Awaited<
            ReturnType<Parameters<Parameters<typeof SnapshotMaintenance.withCapture>[0]>[0]["exportSnapshots"]>
          >
        }) => Promise<void>,
      ) {
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
              const held = lease
              if (!held) throw new Error("Missing actual source maintenance")
              if (after) {
                const segment = await capture.exportSnapshots({
                  archive,
                  directory: path.join(service.root, "snapshot-segment"),
                })
                await after({ archive: evidence, native, lease: held, segment })
              }
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

test.each(["native-organization-ownership-v1", "native-organization-ownership-v2"] as const)(
  "a fixed archived Home2 %s segment stays verifiable without ordinary-reader fallback",
  async (previous) => {
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
  },
)

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

test("cohort capture retains Hosted holds until the original Service release reopens admission", async () => {
  await using selected = await source(true, true)
  const serviceOwner = await selected.service.service.maintenance.run(async () => ({
    runtime: RuntimeContext.current(),
    store: Storage.current().store,
  }))
  const hostedOwner = await selected.runtime.run(async () => ({
    runtime: RuntimeContext.current(),
    store: Storage.current().store,
  }))
  const matches = (owner: typeof serviceOwner) =>
    RuntimeContext.tryCurrent() === owner.runtime && Storage.current().store === owner.store
  const beforeEpoch = await connectionState(selected.home, selected.registration).read()
  const serviceEntered = Promise.withResolvers<void>()
  const serviceRelease = Promise.withResolvers<void>()
  const failure = new Error("Original Service release was cancelled")
  const aborted = new AbortController()
  aborted.abort(failure)
  let serviceLease: RuntimeMaintenance.Lease | undefined
  let hostedLease: RuntimeMaintenance.Lease | undefined
  let failService = true
  let serviceReopened = false
  let hostedReleasedBeforeService = 0
  const begin = RuntimeMaintenance.begin
  const release = RuntimeMaintenance.release
  using beginning = spyOn(RuntimeMaintenance, "begin").mockImplementation(async (input) => {
    const lease = await begin(input)
    if (input.purpose === "organization-backup") {
      if (matches(serviceOwner)) serviceLease = lease
      else if (matches(hostedOwner)) hostedLease = lease
    }
    return lease
  })
  using releasing = spyOn(RuntimeMaintenance, "release").mockImplementation(async (lease, options) => {
    if (matches(serviceOwner) && lease === serviceLease) {
      if (failService) {
        failService = false
        serviceEntered.resolve()
        await serviceRelease.promise
        return release(lease, { ...options, signal: aborted.signal })
      }
      const result = await release(lease, options)
      serviceReopened = true
      return result
    }
    if (matches(hostedOwner) && lease === hostedLease && !serviceReopened) hostedReleasedBeforeService++
    return release(lease, options)
  })
  let epochThreshold = beforeEpoch
  let resumed = Promise.withResolvers<number>()
  selected.service.interceptFrames((socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (
      frame.type === "heartbeat" &&
      socket.data.handshake?.runtimeID === selected.registration.runtimeID &&
      frame.connectionEpoch > epochThreshold
    )
      resumed.resolve(frame.connectionEpoch)
    return false
  })
  const capture = (name: string) =>
    Cohort.capture({
      service: Cohort.service(selected.service.service.maintenance),
      async resolve() {
        return Cohort.hosted(selected.runtime, { native: Native.capture })
      },
      directory: path.join(selected.service.root, name),
      archiveID: name,
      buildVersion: "fixture",
      keys,
      actor,
    })
  const failedCapture = capture("service-release-failure").then(
    (report) => ({ kind: "completed" as const, report }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  )
  try {
    const entry = await Promise.race([
      serviceEntered.promise.then(() => ({ kind: "entered" as const })),
      failedCapture.then((outcome) => ({ kind: "settled" as const, outcome })),
    ])
    if (entry.kind === "settled") {
      if (entry.outcome.kind === "failed") throw entry.outcome.error
      throw new Error("Capture completed before the original Service release entered")
    }
    expect((await selected.service.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe("frozen")
    expect(serviceLease).toBeDefined()
    expect(hostedLease).toBeDefined()
    serviceRelease.resolve()
    const outcome = await failedCapture
    expect(outcome.kind).toBe("failed")
    if (outcome.kind !== "failed") throw new Error("Expected the original Service release failure")
    expect(outcome.error).toBeInstanceOf(AggregateError)
    if (!(outcome.error instanceof AggregateError)) throw outcome.error
    expect(outcome.error.errors).toContain(failure)
    expect((await selected.service.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe("frozen")
    expect((await selected.runtime.run(() => RuntimeMaintenance.status()))?.phase).toBe("frozen")
    expect(hostedReleasedBeforeService).toBe(0)
    if (!serviceLease || !hostedLease) throw new Error("Missing the original captured maintenance leases")
    await selected.service.service.maintenance.run(() => RuntimeMaintenance.release(serviceLease!))
    await selected.runtime.run(() => RuntimeMaintenance.release(hostedLease!))
    epochThreshold = await resumed.promise
    expect(epochThreshold).toBeGreaterThan(beforeEpoch)
    resumed = Promise.withResolvers<number>()
    serviceReopened = false
    const report = await capture("service-release-recovered")
    expect(report).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 2 })
    expect(await resumed.promise).toBeGreaterThan(epochThreshold)
    expect(hostedReleasedBeforeService).toBe(0)
    expect((await selected.service.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
    expect((await selected.runtime.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
  } finally {
    serviceRelease.resolve()
    await failedCapture
    if (serviceLease)
      await selected.service.service.maintenance.run(async () => {
        if ((await RuntimeMaintenance.status())?.phase !== "released") await release(serviceLease!)
      })
    if (hostedLease)
      await selected.runtime.run(async () => {
        if ((await RuntimeMaintenance.status())?.phase !== "released") await release(hostedLease!)
      })
    selected.service.interceptFrames(undefined)
  }
}, 30_000)

async function recoverHostedWriter(withTask = false, late?: "session" | "input", artifact?: "published" | "late") {
  const started = performance.now()
  const phase = (stage: string) => {
    if (!withTask || late === "session" || artifact === "late") return
    console.error(
      "HOSTED_NATIVE_RECOVERY_PHASE",
      JSON.stringify({
        withTask,
        late: late ?? "none",
        artifact: artifact ?? "none",
        stage,
        elapsedMs: performance.now() - started,
      }),
    )
  }
  phase("entered")
  using sourceScopeEnd = { [Symbol.dispose]: () => phase("source-scope-end") }
  await using selected = await source(true, withTask)
  using sourceDisposal = { [Symbol.dispose]: () => phase("source-disposal-enter") }
  phase("source-ready")
  using taskScopeEnd = { [Symbol.dispose]: () => phase("task-scope-end") }
  await using task = withTask ? await completedHostedTask(selected) : undefined
  using taskDisposal = { [Symbol.dispose]: () => phase("task-disposal-enter") }
  phase("task-ready")
  const artifactHistory = artifact && task ? await publishArtifactHistory(selected.service, task) : undefined
  const originalCalls = task?.calls.length ?? 0
  if (task && !late) await verifyCompletedTaskHistory(selected, task)
  const originalInput = task
    ? await selected.runtime.run(() =>
        MessageV2.get({ sessionID: task.sessionID, messageID: task.accepted.effect.messageID }),
      )
    : undefined
  let retiredReference: NamespaceRetirement.Reference | undefined
  let originalTarget:
    | {
        installation: HomeRestoration.Target
        checkpoint: ReturnType<typeof OrganizationRecoveryAuthority.describe>["checkpoint"]
      }
    | undefined
  let hostedMaterial: { native: StorageCheckpoint.Manifest; snapshot: StorageCheckpoint.Manifest } | undefined
  const bytes = Buffer.from("actual Hosted private history bytes")
  await selected.runtime.run(() => Storage.writeBinary(["recovery", "proof"], bytes))
  const directory = path.join(selected.service.root, "retirement-original")
  const report = await Cohort.capture({
    service: Cohort.service(selected.service.service.maintenance),
    async resolve() {
      return Cohort.hosted(selected.runtime, { native: Native.capture })
    },
    directory,
    archiveID: "hosted-retirement-original",
    buildVersion: "fixture",
    keys,
    actor,
  })
  const opened = path.join(selected.service.root, "retirement-original-open")
  await Archive.open({ directory, outputDirectory: opened, keys })
  const inventory = Cohort.NamespaceInventory.parse(
    await Bun.file(path.join(opened, "namespaces", "0000000000000000", "namespace.json")).json(),
  )
  await using target = await openOrganizationRecovery({
    home: path.join(await fs.realpath(selected.service.root), "retirement-service-target"),
  })
  if (!inventory.native) throw new Error("Missing actual original service native material")
  const serviceBase = path.join(opened, "namespaces", "0000000000000000")
  const request = OrganizationServiceNative.installationRequest({
    restoreID: "hosted-retirement-original-target",
    source: inventory.namespace,
    expected: inventory.native,
    snapshot: inventory.segment.namespace,
    cohort: {
      archiveID: report.archiveID,
      pagesHash: report.pagesHash,
      ordinal: inventory.ordinal,
      source: { orgID: inventory.identity.orgID, deploymentIncarnation: inventory.identity.deploymentIncarnation },
    },
  })
  const original = await target.run(async () => {
    const installation = await HomeRestoration.begin(request)
    return HomeRestoration.withTarget(installation, (permit) =>
      OrganizationServiceNative.withInstalled(
        {
          permit,
          request,
          directory: path.join(serviceBase, "native"),
          expected: inventory.native!,
          source: inventory.namespace,
          keys,
        },
        (native) =>
          SnapshotMaintenance.withInstalledSegment(
            {
              permit,
              request,
              namespaceDirectory: path.join(serviceBase, "records"),
              directory: path.join(serviceBase, "snapshots"),
              source: inventory.namespace,
              expected: inventory.segment.namespace,
              keys,
            },
            async (snapshot) => {
              await StorageCheckpoint.restoreArchive({
                directory: path.join(serviceBase, "records"),
                expected: inventory.namespace,
                keys,
                restoreID: request.restoreID,
                async finalize(tx, archive) {
                  await OrganizationServiceNative.adoptRestoration(tx, { permit, request, native, snapshot, archive })
                },
              })
              const prepared = await OrganizationRecoveryAuthority.prepare({
                permit,
                request,
                native,
                namespaceDirectory: path.join(serviceBase, "records"),
                keys,
              })
              const original = OrganizationRecoveryAuthority.describe(prepared).reference
              originalTarget = {
                installation,
                checkpoint: OrganizationRecoveryAuthority.describe(prepared).checkpoint,
              }
              expect(original.installationID).toBe(HomeRestoration.describe(permit).installationID)
              return original
            },
          ),
      ),
    )
  })
  await using lateTask = late === "session" ? await completedHostedTask(selected) : undefined
  if (late === "input") {
    if (!task) throw new Error("Expected the original completed task")
    await appendCompletedHostedTask(selected, task)
  }
  if (artifact === "late" && task) await publishArtifactHistory(selected.service, task, 3, 3)
  if (!originalTarget) throw new Error("Missing original target preparation")
  const h0 = originalTarget
  const withPolicyTarget = <T>(body: (evidence: OrganizationRecovery.Target) => Promise<T>) =>
    target.run(() =>
      HomeRestoration.withTarget(h0.installation, (permit) =>
        OrganizationServiceNative.withInstalled(
          {
            permit,
            request,
            directory: path.join(serviceBase, "native"),
            expected: inventory.native!,
            source: inventory.namespace,
            keys,
          },
          async (native) => {
            const prepared = await OrganizationRecoveryAuthority.reopen({
              permit,
              request,
              native,
              namespaceDirectory: path.join(serviceBase, "records"),
              keys,
            })
            return OrganizationRecovery.withTarget({ permit, request, native, prepared }, body)
          },
        ),
      ),
    )
  let serviceLease: RuntimeMaintenance.Lease | undefined
  await selected.service.service.maintenance.run(async () => {
    serviceLease = await RuntimeMaintenance.begin({
      purpose: "organization-backup",
      requestID: "actual-hosted-recovery-publication",
      actor: { ...actor, requestID: "actual-hosted-recovery-publication" },
    })
    await RuntimeMaintenance.freeze(serviceLease, await RuntimeMaintenance.drain(serviceLease))
    return OrganizationCurrentAuthority.withSource(
      {
        lease: serviceLease,
        after: h0.checkpoint,
        directory: path.join(selected.service.root, "service-current"),
        buildVersion: "fixture",
        keys,
      },
      async (current) => {
        if (late || artifact === "late") {
          await selected.capture()
          const outcome = await withPolicyTarget((policyTarget) =>
            selected.service.service.maintenance.run(() =>
              OrganizationRecovery.reconstruct({ source: current, target: policyTarget }),
            ),
          ).then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          )
          const sourceState = await selected.service.service.maintenance.run(async () => ({
            schemaVersion: (
              await HomeOwnershipFile.open({
                root: path.join(selected.service.service.home, ".synergy"),
                env: { SYNERGY_TEST_HOME: selected.service.service.home },
              }).read()
            )?.schemaVersion,
            reserved: serviceLease
              ? (await RuntimeMaintenance.retirement(serviceLease.maintenanceID)) !== undefined
              : true,
          }))
          expect(sourceState).toEqual({ schemaVersion: 2, reserved: false })
          if (outcome.kind !== "rejected") throw new Error("Direct reconstruction accepted unsupported H0 task facts")
          expect(outcome.error).toBeInstanceOf(RuntimeMaintenance.Blocked)
          return
        }
        await selected.capture(undefined, undefined, async (captured) => {
          hostedMaterial = { native: captured.native.namespace, snapshot: captured.segment.namespace }
          const preflight = () =>
            withPolicyTarget((policyTarget) =>
              selected.service.service.maintenance.run(() =>
                OrganizationRecovery.preflightWriters({ source: current, target: policyTarget }),
              ),
            )
          await preflight()
          await NamespaceRetirement.withSource(
            {
              archive: captured.archive,
              lease: captured.lease,
              native: captured.native,
              target: { request, installationID: original.installationID, incarnation: original.incarnation },
            },
            async (current) => {
              const capturedReference = NamespaceRetirement.describeSource(current)
              retiredReference = capturedReference
              const reference = capturedReference
              expect(reference.namespace.identity).toMatchObject({
                kind: "hosted",
                orgID: selected.registration.orgID,
                runtimeID: selected.registration.runtimeID,
                publicKey: selected.registration.publicKey,
              })
              expect(reference.target.request).toEqual(request)
              const hostedRequest = OrganizationHostedRecovery.request({
                restoreID: "restored-hosted",
                source: reference,
                snapshot: captured.segment.namespace,
              })
              await using restored = await openHostedRecovery({
                request: hostedRequest,
                home: path.join(selected.service.root, "hosted-target"),
                identity: selected.home.identity,
              })
              const receipt = await NamespaceRetirement.retire(current)
              const marker = await HomeOwnershipFile.open({
                root: selected.home.root,
                env: { SYNERGY_TEST_HOME: selected.home.home },
              }).read()
              expect(marker).toMatchObject({
                schemaVersion: 4,
                maintenanceID: captured.lease.maintenanceID,
                source: { schemaVersion: 2, owner: "organization-runtime" },
              })
              await expect(readHostedHome(selected.home.home, selected.home.identity)).rejects.toThrow()
              await NamespaceRetirement.withVerified(receipt, (inspection) =>
                target.run(async () => {
                  expect(NamespaceRetirement.inspect(inspection)).toEqual(reference)
                }),
              )
              expect(NamespaceRetirement.describe(await NamespaceRetirement.complete(reference))).toEqual(reference)
              await NamespaceRetirement.withVerified(receipt, (inspection) =>
                restored.run(async () => {
                  const request = OrganizationHostedRecovery.request({
                    restoreID: "restored-hosted",
                    source: reference,
                    snapshot: captured.segment.namespace,
                  })
                  await HomeRestoration.withTarget(restored.target, async (permit) => {
                    await restored.withRestorationBase((base) =>
                      OrganizationHostedRecovery.restore({
                        base,
                        permit,
                        request,
                        source: inspection,
                        namespaceDirectory: path.join(selected.service.root, "records"),
                        native: { directory: captured.native.directory, expected: captured.native.namespace },
                        snapshot: { directory: captured.segment.directory, expected: captured.segment.namespace },
                        keys,
                      }),
                    )
                    expect(Buffer.from(await Storage.readBinary(["recovery", "proof"]))).toEqual(bytes)
                    expect(await RuntimeMaintenance.status()).toMatchObject({
                      phase: "recovery-held",
                      purpose: "organization-restore",
                    })
                  })
                }),
              )
              await expect(
                readHostedHome(path.join(selected.service.root, "hosted-target"), selected.home.identity),
              ).rejects.toThrow()
              await restored.close()
              await using cold = await openHostedRecovery({
                request: hostedRequest,
                home: path.join(selected.service.root, "hosted-target"),
                identity: selected.home.identity,
              })
              await cold.run(async () => {
                expect(Buffer.from(await Storage.readBinary(["recovery", "proof"]))).toEqual(bytes)
              })
            },
          )
        })
        await selected.runtime.run(async () => {
          const info = await RuntimeMaintenance.status()
          if (!info) throw new Error("Missing retired writer hold")
          expect(info.phase).toBe("frozen")
        })
        if (!retiredReference) throw new Error("Missing original permanent reference")
        const reference = retiredReference
        if (!originalTarget || !hostedMaterial) throw new Error("Missing original installed target or native material")
        const material = hostedMaterial
        await selected.close()
        await using coldSource = await openHostedSourceRetirement({
          home: selected.home.home,
          identity: selected.home.identity,
          reference,
        })
        await coldSource.run(async () => {
          expect(() => NamespaceRetirement.complete(reference)).toThrow("writable")
          await expect(Storage.write(["unauthorized", "writer"], true)).rejects.toThrow()
          const receipt = await NamespaceRetirement.read(reference)
          await NamespaceRetirement.withVerified(receipt, (inspection) =>
            withPolicyTarget((policyTarget) =>
              selected.service.service.maintenance.run(() =>
                OrganizationCurrentAuthority.withCaptured(current, async (captured) => {
                  const policy = await OrganizationRecovery.reconstruct({ source: current, target: policyTarget })
                  const physical = await OrganizationSourceRetirement.complete(policy.source)
                  await OrganizationRecovery.publishReconciled({
                    source: physical,
                    target: policyTarget,
                    namespace: captured.namespace,
                    native: captured.native,
                    keys,
                    writers: [inspection],
                    publicOrigin: "https://organization.example",
                  })
                }),
              ),
            ),
          )
        })
      },
    )
  })
  if (late || artifact === "late") {
    expect(retiredReference).toBeUndefined()
    expect(
      await HomeOwnershipFile.open({ root: selected.home.root, env: { SYNERGY_TEST_HOME: selected.home.home } }).read(),
    ).toMatchObject({ schemaVersion: 2 })
    expect(
      await HomeOwnershipFile.open({
        root: path.join(selected.service.service.home, ".synergy"),
        env: { SYNERGY_TEST_HOME: selected.service.service.home },
      }).read(),
    ).toMatchObject({ schemaVersion: 2 })
    const held = await selected.runtime.run(() => RuntimeMaintenance.status())
    const serviceHold = serviceLease
    if (!held || !serviceHold) throw new Error("Expected original unreleased native holds")
    expect(await selected.runtime.run(() => RuntimeMaintenance.retirement(held.maintenanceID))).toBeUndefined()
    expect(
      await selected.service.service.maintenance.run(() => RuntimeMaintenance.retirement(serviceHold.maintenanceID)),
    ).toBeUndefined()
    await selected.releaseCapture()
    await selected.service.service.maintenance.run(() => RuntimeMaintenance.release(serviceHold))
    expect((await selected.runtime.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
    expect((await selected.service.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
    phase("all-assertions-complete")
    return
  }
  await target.run(() => OrganizationRecovery.completeServicePublication(original.installationID))
  if (!retiredReference || !hostedMaterial) throw new Error("Missing original retired Hosted material")
  const reference = retiredReference
  const material = hostedMaterial
  const hostedRequest = OrganizationHostedRecovery.request({
    restoreID: "restored-hosted",
    source: reference,
    snapshot: material.snapshot,
  })
  await using publishing = await openHostedRecovery({
    home: path.join(selected.service.root, "hosted-target"),
    identity: selected.home.identity,
    request: hostedRequest,
  })
  await target.run(() =>
    OrganizationRecoveryPublication.withPublishedHosted(
      { installationID: original.installationID, runtimeID: selected.registration.runtimeID },
      (service) =>
        publishing.run(() =>
          HomeRestoration.withTarget(publishing.target, (permit) =>
            OrganizationHostedRecovery.publish({
              permit,
              request: hostedRequest,
              service,
              native: { directory: path.join(selected.service.root, "native"), expected: material.native },
              keys,
            }),
          ),
        ),
    ),
  )
  const enteredCompletion = Promise.withResolvers<void>()
  const finishCompletion = Promise.withResolvers<void>()
  const writeFile = FileAtomicWrite.write
  using heldCompletion = spyOn(FileAtomicWrite, "write").mockImplementation(async (...args) => {
    if (args[1].at(-1) === "organization-registration.json") {
      enteredCompletion.resolve()
      await finishCompletion.promise
    }
    return writeFile(...args)
  })
  const acceptedCompletion = await publishing.run(async () => {
    const work = OrganizationHostedRecovery.complete((await HomeRestoration.inspect(publishing.target)).installationID)
    void work.catch(() => {})
    return { work }
  })
  await enteredCompletion.promise
  let closed = false
  const closing = publishing.close().then(() => {
    closed = true
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
  } finally {
    finishCompletion.resolve()
  }
  await closing
  await acceptedCompletion.work
  expect(closed).toBe(true)
  phase("hosted-completion-verified")
  await target.close()
  phase("target-closed")
  await selected.service.service.close()
  phase("source-service-closed")
  await selected.service.stopListener()
  phase("source-listener-stopped")
  const normalService = await openOrganizationService({
    home: path.join(await fs.realpath(selected.service.root), "retirement-service-target"),
  })
  phase("restored-service-opened")
  await using serviceCleanup = {
    async [Symbol.asyncDispose]() {
      phase("restored-service-disposal-enter")
      try {
        await normalService.close()
      } finally {
        phase("restored-service-disposal-settled")
      }
    },
  }
  const connected = Promise.withResolvers<void>()
  const restoredServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(selected.service.origin).port),
    tls: { cert, key: certificateKey },
    websocket: {
      ...normalService.websocket,
      message(socket, frame) {
        if (Protocol.ClientFrame.parse(JSON.parse(String(frame))).type === "heartbeat") connected.resolve()
        return normalService.websocket.message(socket, frame)
      },
    },
    fetch: normalService.fetch,
  })
  await using listenerCleanup = {
    async [Symbol.asyncDispose]() {
      phase("restored-listener-disposal-enter")
      try {
        await restoredServer.stop(true)
      } finally {
        phase("restored-listener-disposal-settled")
      }
    },
  }
  if (artifactHistory) {
    phase("artifact-history-enter")
    await verifyArtifactHistory(selected.service, normalService, artifactHistory)
    phase("artifact-history-verified")
  }
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  using ordinaryScopeEnd = { [Symbol.dispose]: () => phase("ordinary-scope-end") }
  await using ordinary = await openHostedRuntime({
    home: path.join(selected.service.root, "hosted-target"),
    identity: selected.home.identity,
    ca: selected.service.ca,
    workspaceCoordinator: selected.workspaceCoordinator,
    listen: { port, token: "e".repeat(64) },
  })
  using ordinaryDisposal = { [Symbol.dispose]: () => phase("ordinary-disposal-enter") }
  phase("ordinary-opened")
  const timer = setTimeout(() => connected.reject(new Error("Restored Hosted writer did not reconnect")), 3000)
  try {
    await connected.promise
  } finally {
    clearTimeout(timer)
  }
  expect(
    (await readRuntimeRegistration(path.join(selected.service.root, "hosted-target"), selected.home.identity))
      ?.runtimeID,
  ).toBe(selected.registration.runtimeID)
  expect(
    (await readHostedHome(path.join(selected.service.root, "hosted-target"), selected.home.identity)).publicKey,
  ).toBe(selected.home.publicKey)
  expect(Buffer.from(await ordinary.run(() => Storage.readBinary(["recovery", "proof"])))).toEqual(bytes)
  if (task) {
    const recovered = await ordinary.run(() => Session.get(task.sessionID))
    expect(recovered.paused).toBeDefined()
    expect(recovered.organization).toEqual(task.info.organization)
    const original = await ordinary.run(() =>
      RolloutLedger.getRun(
        { kind: "session", scopeID: recovered.scope.id, sessionID: recovered.id },
        task.nativeRelease.rootID,
      ),
    )
    expect(original.status).toBe("completed")
    expect(original.id).toBe(task.accepted.effect.messageID)
    if (!originalInput || originalInput.info.role !== "user")
      throw new Error("Expected the original accepted native user input")
    expect(originalInput.info.actor).toMatchObject({ kind: "account", subjectID: task.accepted.permit.actor.subjectID })
    const input = await ordinary.run(() => MessageV2.get({ sessionID: recovered.id, messageID: original.id }))
    if (input.info.role !== "user") throw new Error("Restored root changed its original input role")
    expect(input.info.actor).toEqual(originalInput.info.actor)
    expect(task.calls.length).toBe(originalCalls)
  }
  phase("all-assertions-complete")
}

test(
  "an enrolled Hosted namespace permanently fences its actual writer and binds the original service target request",
  () => recoverHostedWriter(),
  15_000,
)

test(
  "a genuinely completed model task survives service and Hosted recovery without replay",
  () => recoverHostedWriter(true),
  60_000,
)

test(
  "published Artifact versions and bytes survive actual Hosted task recovery",
  () => recoverHostedWriter(true, undefined, "published"),
  60_000,
)

test(
  "a new H1 Artifact version refuses recovery before either permanent source fence",
  () => recoverHostedWriter(true, undefined, "late"),
  20_000,
)

test(
  "direct reconstruction rejects a completed Session created after H0 before either permanent fence",
  () => recoverHostedWriter(false, "session"),
  20_000,
)

test(
  "direct reconstruction rejects a second completed task after H0 before permanent retirement",
  () => recoverHostedWriter(true, "input"),
  60_000,
)

test("a completed Hosted model task drains its actual native writers before capture and ordinary shutdown", async () => {
  await using selected = await source(true)
  await using task = await completedHostedTask(selected)
  const captured = await selected.capture()
  expect(await selected.runtime.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
  const native = await Native.verify({
    directory: captured.native.directory,
    expected: captured.native.namespace,
    source: captured.archive.namespace,
    keys,
  })
  expect(native.registration).toEqual(selected.registration)
  expect(await selected.runtime.run(() => Session.get(task.sessionID))).toMatchObject({
    organization: task.info.organization,
  })
  await selected.close()
}, 15_000)

test("an unknown paused Hosted gateway refuses native capture without retiring or trapping its original writer", async () => {
  await using selected = await source(true)
  await using task = await pausedHostedTask(selected)
  const pending = await selected.runtime.run(() => OrganizationExecutionLeases.page(selected.registration.runtimeID))
  expect(pending.items.length).toBeGreaterThan(0)
  await expect(selected.capture()).rejects.toMatchObject({
    data: { requirements: [{ owner: "organization-execution-leases", code: "execution_generation_pending" }] },
  })
  const maintenance = await selected.runtime.run(() => RuntimeMaintenance.status())
  expect(maintenance?.phase).toBe("frozen")
  if (!maintenance) throw new Error("Expected the original maintenance hold")
  expect(await selected.runtime.run(() => RuntimeMaintenance.retirement(maintenance.maintenanceID))).toBeUndefined()
  expect(await selected.runtime.run(() => OrganizationExecutionLeases.page(selected.registration.runtimeID))).toEqual(
    pending,
  )
  expect(await readHostedHome(selected.home.home, selected.home.identity)).toMatchObject({
    publicKey: selected.home.publicKey,
  })
  const info = await selected.runtime.run(() => Session.get(task.sessionID))
  expect(info.paused).toEqual(task.info.paused)
  expect(info.organization).toEqual(task.info.organization)
  const resumed = Promise.withResolvers<void>()
  selected.service.interceptFrames((_socket, raw) => {
    const frame = Protocol.ClientFrame.parse(JSON.parse(String(raw)))
    if (frame.type === "heartbeat" && frame.connectionEpoch > selected.registration.connectionEpoch) resumed.resolve()
    return false
  })
  await selected.releaseCapture()
  const timer = setTimeout(
    () => resumed.reject(new Error("Original Hosted bridge did not resume after refused capture")),
    3000,
  )
  try {
    await resumed.promise
  } finally {
    clearTimeout(timer)
  }
  expect((await selected.runtime.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
  const gateway = await selected.service.service.maintenance.run(async () => {
    const values = []
    for await (const row of Storage.records({ prefix: ["organization", "gateway-calls"], limit: 128 }))
      values.push(row.value)
    return values
  })
  expect(gateway).toEqual(task.gateway)
  await selected.close()
}, 15_000)
