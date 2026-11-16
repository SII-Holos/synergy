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
import { AgentTurn } from "@ericsanchezok/synergy-harness/session/agent-turn"
import { ModelExecution } from "@ericsanchezok/synergy-harness/execution/model-execution"
import { ProviderRequestSource } from "@ericsanchezok/synergy-harness/provider/request-source"
import { ObservabilityRedaction } from "@ericsanchezok/synergy-harness/observability/redaction"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import {
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationHostedRecovery, openHostedRecovery, openHostedSourceRetirement } from "../../src/backup/recovery"
import { OrganizationRuntimeNative as Native } from "../../src/backup/native"
import { OrganizationKnowledgeNative as KnowledgeNative } from "../../src/backup/knowledge"
import { prepareHostedHome, readHostedHome, runtimeIdentityDigest, NativeHomeReaderContract } from "../../src/home"
import { enrollHostedRuntime } from "../../src/enrollment"
import { readRuntimeRegistration } from "../../src/registration"
import { registerOrganizationNamespaceIdentity } from "../../src/namespace-identity"
import { connectionState } from "../../src/connection-state"
import { readCredentials } from "../../src/credentials"
import { fixture } from "../support/organization"
import {
  completedHostedTask,
  failedHostedTask,
  continueRestoredHostedTask,
  verifyRecoveredHandoffTaskHistory,
  queuedHostedTask,
  pausedHostedTask,
  appendCompletedHostedTask,
  continueQueuedHostedTask,
  verifyClosedTaskHistory,
} from "../support/hosted-task"
import { openHostedRuntime, openMemberRuntime } from "../../src/runtime"
import { memberTaskToHosted } from "../support/member-handoff-task"
import { failedKnowledgeActivation } from "../support/failed-knowledge-activation"
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
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { publishArtifactHistory, verifyArtifactHistory } from "../support/artifact-history"
import { hostedCloudResourceFixture } from "../support/backup-cloud-resources"
import { terminalHostedCancel, settledHostedQuestion } from "../support/hosted-control-history"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Question } from "@ericsanchezok/synergy-local-runtime/question"
import { recoveryContinuationAuthority } from "../support/recovery-continuation-authority"
import { shareAckUnshareHostedTask } from "../support/hosted-shared-history"
import { captureHostedRepeatHistory } from "../support/hosted-repeat-history"

type CloudResources = Awaited<ReturnType<typeof hostedCloudResourceFixture>>

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

async function openNativeFixture(
  input: Parameters<typeof openHostedRuntime>[0] | Parameters<typeof openMemberRuntime>[0],
) {
  const homes = new Set([path.resolve(input.home), await fs.realpath(input.home)])
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
          if (!installed && homes.has(RuntimeContext.current().host.home)) {
            ResourceHost.register(resources)
            installed = true
          }
          composition.register()
        },
      }
    })
    return "accountID" in input.identity
      ? await openMemberRuntime({ ...input, identity: input.identity })
      : await openHostedRuntime({ ...input, identity: input.identity })
  })()
  if (!(await runtime.run(async () => ResourceHost.get() === resources))) {
    await runtime.close()
    throw new Error("The original Hosted fixture did not register its selected resource observations")
  }
  return runtime
}

function createHostedRecoveryCapture(
  runtime: { run<T>(body: () => Promise<T>): Promise<T> },
  directory: string,
  captureActor = actor,
) {
  let lease: RuntimeMaintenance.Lease | undefined
  const releaseCapture = async () => {
    const active = lease
    if (!active) return
    await runtime.run(async () => {
      if (!(await RuntimeMaintenance.retirement(active.maintenanceID))) await RuntimeMaintenance.release(active)
    })
    lease = undefined
  }
  return {
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
        lease = await RuntimeMaintenance.begin({
          purpose: "organization-backup",
          requestID: captureActor.requestID,
          actor: captureActor,
        })
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
        return RuntimeMaintenance.withFrozen(lease, () =>
          SnapshotMaintenance.withCapture(async (capture) => {
            const archive = await capture.exportArchive({
              directory: path.join(directory, "records"),
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
              directory: path.join(directory, "native"),
              keys,
              signal,
            })
            const held = lease
            if (!held) throw new Error("Missing actual source maintenance")
            if (after) {
              const segment = await capture.exportSnapshots({
                archive,
                directory: path.join(directory, "snapshot-segment"),
              })
              await after({ archive: evidence, native, lease: held, segment })
            }
            return { archive, native }
          }),
        )
      })
    },
  }
}

async function source(
  production = false,
  withTask = false,
  options: { warmWorker?: boolean; cloud?: CloudResources["sourceCloud"]; handoff?: true } = {},
) {
  const service = await fixture(
    production && withTask
      ? { connections: { heartbeatMs: 25 }, ...(options.cloud ? { cloud: options.cloud } : {}) }
      : options.cloud
        ? { cloud: options.cloud }
        : {},
  )
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
      ? await openNativeFixture({
          home: home.home,
          identity: home.identity,
          ca: service.ca,
          workspaceCoordinator,
          ...(options.handoff ? { handoff: options.handoff } : {}),
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
    const { capture, releaseCapture } = createHostedRecoveryCapture(runtime, service.root)
    let closed = false
    const close = async () => {
      if (closed) return
      await releaseCapture()
      await runtime.close()
      closed = true
    }
    if (production && withTask && options.warmWorker) {
      try {
        await runtime.run(async () => {
          expect(ModelExecution.mode()).toBe("worker")
          await AgentTurn.prewarm()
          const workers = AgentTurn.stats()
          expect(workers.minIdle).toBeGreaterThan(0)
          expect(workers.ready).toBeGreaterThanOrEqual(workers.minIdle)
        })
      } catch (error) {
        try {
          await close()
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Hosted worker setup and original Runtime cleanup failed")
        }
        throw error
      }
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
      capture,
      async [Symbol.asyncDispose]() {
        await close()
        await service[Symbol.asyncDispose]()
      },
    }
  } catch (error) {
    try {
      await service[Symbol.asyncDispose]()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Hosted source setup and original Service cleanup failed")
    }
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

type QueuedTargetInboxFault = {
  kind: "target-inbox-revision"
  injections: number
  rawRestoreCompleted: boolean
  rejectedBySignedRoster: boolean
  originalInboxRestored: boolean
  originalPermitRetained: boolean
  sourceUnchanged: boolean
  publicationAbsent: boolean
  zeroModelReplay: boolean
  failure?: unknown
}

async function rejectChangedQueuedTargetInbox(
  input: {
    fault: QueuedTargetInboxFault
    permit: HomeRestoration.InstallPermit
    request: OrganizationHostedRecovery.Request
    scopeID: string
    sessionID: string
    itemID: string
    sourceFiles: string[]
    calls(): number
  },
  restore: () => Promise<unknown>,
): Promise<never> {
  const fault = input.fault
  const runtime = RuntimeContext.current()
  const store = Storage.current().store
  const target = HomeRestoration.describe(input.permit)
  const modelCalls = input.calls()
  const sourceBytes = await Promise.all(input.sourceFiles.map((file) => fs.readFile(file)))
  const address = StoragePath.sessionInboxItem(
    Identifier.asScopeID(input.scopeID),
    Identifier.asSessionID(input.sessionID),
    input.itemID,
  )
  let original: SessionInbox.StoredItem | undefined
  let failure: { error: unknown } | undefined
  const guard = () => {
    HomeRestoration.assertCurrent(input.permit)
    HomeRestoration.assertRequest(input.permit, input.request)
    if (RuntimeContext.current() !== runtime || Storage.current().store !== store)
      throw new Error("Queued Target fault lost its original Runtime or Store")
  }
  const restoreArchive = StorageCheckpoint.restoreArchive
  using installed = spyOn(StorageCheckpoint, "restoreArchive").mockImplementation(async (value) => {
    const restored = await restoreArchive(value)
    if (
      RuntimeContext.current() !== runtime ||
      Storage.current().store !== store ||
      value.restoreID !== input.request.restoreID ||
      JSON.stringify(value.expected) !== JSON.stringify(input.request.payload.source.archive)
    )
      return restored
    guard()
    if (fault.injections) throw new Error("Queued Target fault entered more than once")
    fault.rawRestoreCompleted = true
    const [stored] = await Storage.readMany<SessionInbox.StoredItem>([address])
    guard()
    if (
      !stored ||
      stored.id !== input.itemID ||
      stored.sessionID !== input.sessionID ||
      !Number.isSafeInteger(stored.revision)
    )
      throw new Error("Actual installed Target lacks the original canonical Inbox")
    original = stored
    const actual = await SessionInbox.getStored(input.sessionID, input.itemID)
    guard()
    expect(actual).toEqual(original)
    fault.injections++
    await RuntimeMaintenance.restorationTransaction(
      { permit: input.permit, request: input.request },
      (tx) => tx.write(address, { ...stored, revision: stored.revision + 1 }),
      { commitGuard: guard },
    )
    guard()
    expect((await Storage.readMany<SessionInbox.StoredItem>([address]))[0]?.revision).toBe(stored.revision + 1)
    return restored
  })
  try {
    await restore()
  } catch (error) {
    failure = { error }
    fault.failure = error
    fault.rejectedBySignedRoster =
      error instanceof Error &&
      error.message === "Hosted restoration installed queued native state differs from its signed snapshot"
  } finally {
    const errors: unknown[] = []
    try {
      guard()
      if (original) {
        const retained = original
        await RuntimeMaintenance.restorationTransaction(
          { permit: input.permit, request: input.request },
          (tx) => tx.write(address, retained),
          { commitGuard: guard },
        )
        guard()
        fault.originalInboxRestored =
          JSON.stringify((await Storage.readMany([address]))[0]) === JSON.stringify(original)
      }
      guard()
      fault.originalPermitRetained = JSON.stringify(HomeRestoration.describe(input.permit)) === JSON.stringify(target)
      const current = await Promise.all(input.sourceFiles.map((file) => fs.readFile(file)))
      guard()
      fault.sourceUnchanged = current.every((bytes, index) => bytes.equals(sourceBytes[index]!))
      fault.publicationAbsent =
        (await Storage.readMany([["organization-runtime-recovery", "publication", target.installationID]]))[0] ===
        undefined
      guard()
      fault.zeroModelReplay = input.calls() === modelCalls
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      throw new AggregateError(
        [...(failure ? [failure.error] : []), ...errors],
        "Queued Target refusal or original fixture restoration did not complete",
      )
  }
  if (!failure) throw new Error("Actual queued Target accepted changed canonical Inbox data")
  throw failure.error
}

type HostedRecoveryHistory =
  | "queued-continue"
  | "terminal-cancel"
  | "settled-question"
  | "failed-root-continue"
  | "paused-queued-capture"
  | "paused-queued-recovery"
  | "member-handoff"
  | "member-handoff-failed-root"
  | "failed-knowledge-activation"
  | "failed-knowledge-nonempty"
  | "share-ack-unshare"
  | "paused-queued-repeat"

type HostedRecoverySource = Pick<
  Awaited<ReturnType<typeof source>>,
  "home" | "registration" | "service" | "runtime" | "workspaceCoordinator" | "close" | "releaseCapture" | "capture"
>
type HostedRecoveryCohort = { directory: string; report: Awaited<ReturnType<typeof Cohort.capture>> }
type ReopenedHostedRecovery = {
  runtime: HostedRecoverySource["runtime"]
  service: Awaited<ReturnType<typeof openOrganizationService>>
  home: Awaited<ReturnType<typeof readHostedHome>>
  registration: Protocol.HostedRegistrationRecord
  installationID: string
  headers?: Awaited<ReturnType<typeof fixture>>["headers"]
  cohort?: HostedRecoveryCohort
  sourceNamespace: { directory: string; expected: StorageCheckpoint.Manifest }
  stopListener(): Promise<void>
}

function observeRepeatedHostedRecoveryFailure(
  stage: "provider-preparation" | "recovery",
  error: unknown,
  context?: { sourceRuntimeMatches: boolean; sourceHomeMatches: boolean; runtimeAvailable: boolean },
) {
  try {
    const seen = new Set<object>()
    const field = (value: unknown, name: string, inherited = false): unknown => {
      try {
        let current = value
        for (let index = 0; index < (inherited ? 4 : 1); index++) {
          if (typeof current !== "object" || current === null) return
          const descriptor = Object.getOwnPropertyDescriptor(current, name)
          if (descriptor) return "value" in descriptor ? descriptor.value : undefined
          current = Object.getPrototypeOf(current)
        }
      } catch {}
    }
    const text = (value: string) => {
      const bounded = value.slice(0, 2048)
      const input = value.length > 2048 ? bounded.replace(/\S+$/, "[truncated-token]") : bounded
      return ObservabilityRedaction.text(input, Number.POSITIVE_INFINITY)
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
        .replace(/(?:\/[A-Za-z._~-][^\s"'<>]*|\b[A-Za-z]:\\[^\s"'<>]+)/g, "[path]")
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[ip]")
        .replace(/\[[0-9a-f:.]+(?:%[a-z0-9_.-]+)?\](?::\d+)?/gi, "[ip]")
        .replace(/\b(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]+(?:%[a-z0-9_.-]+)?/gi, "[ip]")
        .replace(/::[0-9a-f][0-9a-f:.]*(?:%[a-z0-9_.-]+)?/gi, "[ip]")
        .replace(/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}\b/gi, "[hostname]")
        .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[identity]")
        .replace(/\b[0-9a-f]{64}\b/gi, "[hash]")
        .replace(/\b(?:ses|msg|prt|org|prj|scp|run|req|grt|tkt|acc|env|rtm)_[A-Za-z0-9_-]+\b/g, "[identity]")
        .slice(0, 512)
    }
    const describe = (value: unknown, depth = 0): unknown => {
      if (value === null || typeof value !== "object")
        return {
          thrownType: value === null ? "null" : typeof value,
          ...(typeof value === "string" ? { message: text(value) } : {}),
        }
      if (depth >= 8 || seen.size >= 32) return { truncated: true }
      if (seen.has(value)) return { repeated: true }
      seen.add(value)
      const name = field(value, "name", true)
      const data = field(value, "data")
      const message = field(value, "message") ?? field(data, "message")
      const code = OrganizationProtocol.ErrorCode.safeParse(field(value, "code") ?? field(data, "code"))
      const outcome = field(value, "outcome") ?? field(data, "outcome")
      const result: Record<string, unknown> = {
        name: typeof name === "string" ? text(name).slice(0, 128) : "UnknownError",
        ...(typeof message === "string" ? { message: text(message) } : {}),
        ...(code.success ? { code: code.data } : {}),
        ...(outcome === "not_dispatched" || outcome === "rejected" || outcome === "unknown" ? { outcome } : {}),
      }
      for (const key of ["cause", "error", "suppressed"]) {
        const nested = field(value, key)
        if (nested !== undefined) result[key] = describe(nested, depth + 1)
      }
      const errors = field(value, "errors")
      if (Array.isArray(errors)) {
        const length = field(errors, "length")
        if (typeof length === "number") {
          const children: unknown[] = []
          for (let index = 0; index < Math.min(length, 8); index++)
            children.push(describe(field(errors, String(index)), depth + 1))
          result.errors = children
          if (length > 8) result.errorsTruncated = length - 8
        }
      }
      return result
    }
    console.error("R9_SECOND_HOSTED_ORIGINAL_FAILURE", JSON.stringify({ stage, ...context, error: describe(error) }))
  } catch {
    try {
      console.error("R9_SECOND_HOSTED_ORIGINAL_FAILURE", JSON.stringify({ stage, observation: "unavailable" }))
    } catch {}
  }
}

async function recoverHostedWriter(
  withTask = false,
  late?: "session" | "input",
  artifact?: "published" | "late",
  cloud?: CloudResources,
  history?: HostedRecoveryHistory,
  queuedFault?: QueuedTargetInboxFault,
) {
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
  await using selected = await source(true, withTask, {
    warmWorker: withTask,
    ...(history === "member-handoff" || history === "member-handoff-failed-root" ? { handoff: true as const } : {}),
    ...(cloud ? { cloud: cloud.sourceCloud } : {}),
  })
  using sourceDisposal = { [Symbol.dispose]: () => phase("source-disposal-enter") }
  phase("source-ready")
  using preparationObservation =
    history === "paused-queued-repeat"
      ? (() => {
          const expected = selected.runtime.run(() => RuntimeContext.current())
          const prepare = ProviderRequestSource.prepare
          return spyOn(ProviderRequestSource, "prepare").mockImplementation(async (...args) => {
            const actual = RuntimeContext.tryCurrent()
            try {
              return await prepare(...args)
            } catch (error) {
              if (error instanceof ProviderRequestSource.PreparationError)
                observeRepeatedHostedRecoveryFailure("provider-preparation", error, {
                  sourceRuntimeMatches: actual === expected,
                  sourceHomeMatches: actual?.host.home === expected.host.home,
                  runtimeAvailable: actual !== undefined,
                })
              throw error
            }
          })
        })()
      : undefined
  using taskScopeEnd = { [Symbol.dispose]: () => phase("task-scope-end") }
  const handedOff =
    withTask && (history === "member-handoff" || history === "member-handoff-failed-root")
      ? await memberTaskToHosted(
          selected,
          openNativeFixture,
          history === "member-handoff-failed-root" ? "failed" : "completed",
        )
      : undefined
  await using task = withTask
    ? (handedOff ??
      (history === "failed-root-continue" ? await failedHostedTask(selected) : await completedHostedTask(selected)))
    : undefined
  using taskDisposal = { [Symbol.dispose]: () => phase("task-disposal-enter") }
  phase("task-ready")
  const runRound = async (
    selected: HostedRecoverySource,
    history?: HostedRecoveryHistory,
    round = 1,
    previous?: HostedRecoveryCohort,
    after?: (reopened: ReopenedHostedRecovery) => Promise<void>,
  ) => {
    const roundID = (value: string) => (round === 1 ? value : `${value}-second`)
    let secondCohort: HostedRecoveryCohort | undefined
    let sourceNamespace: ReopenedHostedRecovery["sourceNamespace"] | undefined
    let ordinaryHeaders: ReopenedHostedRecovery["headers"]
    const artifactHistory = artifact && task ? await publishArtifactHistory(selected.service, task) : undefined
    if (task && !late && round === 1)
      await verifyClosedTaskHistory(
        selected,
        task,
        history === "failed-root-continue" || history === "member-handoff-failed-root" ? "failed" : "completed",
      )
    if (history && (!task || late || artifact || cloud))
      throw new Error("Closed control history requires its original plain task fixture")
    const queuedHistory =
      history === "queued-continue" && task
        ? await continueQueuedHostedTask(selected, task, "before-recovery-queued-input")
        : undefined
    const terminalCancel =
      history === "terminal-cancel" && task ? await terminalHostedCancel(selected, task) : undefined
    const settledQuestion =
      history === "settled-question" && task ? await settledHostedQuestion(selected, task) : undefined
    const queuedCapture =
      (history === "paused-queued-capture" || history === "paused-queued-recovery") && task
        ? await queuedHostedTask(selected, task, "before-capture-saved-queued-input")
        : undefined
    const beforeSharingCalls = task?.calls.length ?? 0
    const sharedHistory =
      history === "share-ack-unshare" && task ? await shareAckUnshareHostedTask(selected, task) : undefined
    if (sharedHistory && task) {
      expect(task.calls).toHaveLength(beforeSharingCalls)
      console.error(
        "HOSTED_UNSHARED_HISTORY_READY",
        JSON.stringify({
          sharedGeneration: sharedHistory.shared.shareGeneration,
          privateGeneration: sharedHistory.unshared.shareGeneration,
          privateState: sharedHistory.unshared.syncState,
          watermark: sharedHistory.watermark,
          ackNextSeq: sharedHistory.acknowledgement.ack.nextSeq,
          committedFirstSeq: sharedHistory.committedBatch.firstSeq,
          committedLastSeq: sharedHistory.committedBatch.lastSeq,
          batchPayloadHash: sharedHistory.committedBatch.payloadHash,
          nativeProjectionVersion: sharedHistory.nativeCheckpoint.projectionVersion,
          nativeSyncState: sharedHistory.nativeCheckpoint.syncState,
          sharedDataHash: sharedHistory.sharedDataHash,
          nativeDataHash: sharedHistory.nativeDataHash,
          retained: sharedHistory.retained,
          modelCallDelta: task.calls.length - beforeSharingCalls,
        }),
      )
    }
    const failedKnowledge =
      (history === "failed-knowledge-activation" || history === "failed-knowledge-nonempty") && task
        ? await failedKnowledgeActivation(selected, task, history === "failed-knowledge-nonempty")
        : undefined
    const originalCalls = task?.calls.length ?? 0
    if (cloud && !task) throw new Error("Selected cloud recovery requires its original completed Hosted task")
    const cloudSelection = cloud && task ? await cloud.select(selected.service, task) : undefined
    if (cloud && task) {
      expect(task.calls).toHaveLength(originalCalls)
      expect(await selected.runtime.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
    }
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
    let knowledgeMaterial: Awaited<ReturnType<typeof KnowledgeNative.capture>> | undefined
    let queuedFacts: Parameters<typeof OrganizationRecovery.reconstruct>[0]["queued"]
    let queuedEntries: OrganizationExecutionLeases.Entry[] | undefined
    const bytes = Buffer.from("actual Hosted private history bytes")
    if (round === 1) await selected.runtime.run(() => Storage.writeBinary(["recovery", "proof"], bytes))
    else expect(Buffer.from(await selected.runtime.run(() => Storage.readBinary(["recovery", "proof"])))).toEqual(bytes)
    const directory = previous?.directory ?? path.join(selected.service.root, "retirement-original")
    const report =
      previous?.report ??
      (await Cohort.capture({
        service: Cohort.service(selected.service.service.maintenance),
        async resolve() {
          return Cohort.hosted(selected.runtime, {
            native: Native.capture,
            ...(failedKnowledge?.nonempty ? { knowledge: KnowledgeNative.capture } : {}),
          })
        },
        directory,
        archiveID: "hosted-retirement-original",
        buildVersion: "fixture",
        keys,
        actor,
      }))
    if (queuedCapture) {
      expect(report.namespaces).toBe(2)
      expect(report.namespaceCheckpointsComplete).toBe(true)
      await queuedCapture.verifyUnchanged()
      expect((await selected.runtime.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
      expect((await selected.service.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe(
        "released",
      )
      if (history === "paused-queued-capture") return
    }
    if (history === "member-handoff" || history === "member-handoff-failed-root") expect(report.namespaces).toBe(2)
    const opened = path.join(selected.service.root, "retirement-original-open")
    await Archive.open({ directory, outputDirectory: opened, keys })
    const inventory = Cohort.NamespaceInventory.parse(
      await Bun.file(path.join(opened, "namespaces", "0000000000000000", "namespace.json")).json(),
    )
    await using target = await openOrganizationRecovery({
      home: path.join(await fs.realpath(selected.service.root), "retirement-service-target"),
      ...(cloud ? { cloud: cloud.targetCloud } : {}),
    })
    if (!inventory.native) throw new Error("Missing actual original service native material")
    const serviceBase = path.join(opened, "namespaces", "0000000000000000")
    const serviceResources = inventory.resources && {
      directory: path.join(serviceBase, "resources"),
      expected: inventory.resources,
      namespaceDirectory: path.join(serviceBase, "records"),
    }
    if (cloud) {
      expect(report).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 2 })
      expect(serviceResources).toBeDefined()
      const hostedInventory = Cohort.NamespaceInventory.parse(
        await Bun.file(path.join(opened, "namespaces", "0000000000000001", "namespace.json")).json(),
      )
      expect(hostedInventory.identity).toMatchObject({ kind: "hosted", runtimeID: selected.registration.runtimeID })
      expect(hostedInventory.hostedNative).toBeDefined()
      expect(hostedInventory.segment.namespace).toBeDefined()
    }
    const request = OrganizationServiceNative.installationRequest({
      restoreID: roundID("hosted-retirement-original-target"),
      source: inventory.namespace,
      expected: inventory.native,
      ...(inventory.resources ? { resources: inventory.resources } : {}),
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
            ...(serviceResources ? { resources: serviceResources } : {}),
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
              ...(serviceResources ? { resources: serviceResources } : {}),
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
        requestID: roundID("actual-hosted-recovery-publication"),
        actor: { ...actor, requestID: roundID("actual-hosted-recovery-publication") },
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
            if (failedKnowledge?.nonempty)
              knowledgeMaterial = await KnowledgeNative.capture({
                archive: captured.archive,
                lease: captured.lease,
                directory: path.join(selected.service.root, "hosted-knowledge-current"),
                keys,
              })
            const preflight = () =>
              withPolicyTarget((policyTarget) =>
                selected.service.service.maintenance.run(() =>
                  OrganizationRecovery.preflightWriters({ source: current, target: policyTarget, queued: queuedFacts }),
                ),
              )
            if (!queuedCapture) await preflight()
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
                if (queuedCapture) {
                  queuedFacts = await Native.withMaterial(
                    {
                      directory: captured.native.directory,
                      expected: captured.native.namespace,
                      source: reference.archive,
                      keys,
                    },
                    async (material) => {
                      const proof = Native.inspectMaterial(material).queued
                      if (!proof) throw new Error("The real queued capture lacks its signed native roster")
                      return [{ source: reference, ...proof }]
                    },
                  )
                  queuedEntries = await selected.runtime.run(async () =>
                    (await OrganizationExecutionLeases.captureEntries()).filter(
                      (entry) =>
                        entry.authority.sessionID === queuedCapture.accepted.permit.sessionID &&
                        entry.authority.rootID === queuedCapture.accepted.effect.messageID,
                    ),
                  )
                  await preflight()
                }
                expect(reference.namespace.identity).toMatchObject({
                  kind: "hosted",
                  orgID: selected.registration.orgID,
                  runtimeID: selected.registration.runtimeID,
                  publicKey: selected.registration.publicKey,
                })
                expect(reference.target.request).toEqual(request)
                const hostedRequest = OrganizationHostedRecovery.request({
                  restoreID: roundID("restored-hosted"),
                  source: reference,
                  snapshot: captured.segment.namespace,
                })
                await using restored = await openHostedRecovery({
                  request: hostedRequest,
                  home: path.join(selected.service.root, "hosted-target"),
                  identity: selected.home.identity,
                })
                const receipt = await NamespaceRetirement.retire(current)
                if (failedKnowledge?.nonempty) await failedKnowledge.removeOriginalCache()
                const marker = await HomeOwnershipFile.open({
                  root: selected.home.root,
                  env: { SYNERGY_TEST_HOME: selected.home.home },
                }).read()
                expect(marker).toMatchObject({
                  schemaVersion: 4,
                  maintenanceID: captured.lease.maintenanceID,
                  source: { schemaVersion: round === 1 ? 2 : 3, owner: "organization-runtime" },
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
                      restoreID: roundID("restored-hosted"),
                      source: reference,
                      snapshot: captured.segment.namespace,
                    })
                    await HomeRestoration.withTarget(restored.target, async (permit) => {
                      const restore = () =>
                        restored.withRestorationBase((base) =>
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
                      if (queuedFault) {
                        if (!queuedCapture || !task || history !== "paused-queued-recovery")
                          throw new Error("Queued Target fault requires its actual complete recovery fixture")
                        await rejectChangedQueuedTargetInbox(
                          {
                            fault: queuedFault,
                            permit,
                            request,
                            scopeID: task.info.scope.id,
                            sessionID: task.sessionID,
                            itemID: queuedCapture.accepted.effect.itemID,
                            sourceFiles: [
                              path.join(selected.home.root, "home-ownership.json"),
                              path.join(captured.native.directory, "manifest.json"),
                              path.join(selected.service.root, "records", "manifest.json"),
                            ],
                            calls: () => task.calls.length,
                          },
                          restore,
                        )
                      } else await restore()
                      if (failedKnowledge?.nonempty) {
                        const knowledge = knowledgeMaterial
                        if (!knowledge) throw new Error("Missing the original fixed nonempty Knowledge facet")
                        await KnowledgeNative.withRestored(
                          {
                            directory: knowledge.directory,
                            expected: knowledge.namespace,
                            source: reference.archive,
                            keys,
                          },
                          async (prepared) => {
                            expect(prepared.manifest.identity).toEqual(reference.namespace)
                            expect(prepared.manifest.files).toBeGreaterThan(0)
                            await RuntimeMaintenance.restorationTransaction(
                              { permit, request },
                              (tx) => prepared.relocate(tx),
                              { commitGuard: prepared.assertCurrent },
                            )
                          },
                        )
                      }
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
          if (!originalTarget || !hostedMaterial)
            throw new Error("Missing original installed target or native material")
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
                    sourceNamespace = {
                      directory: captured.namespace.directory,
                      expected: StorageCheckpoint.Manifest.parse(captured.namespace.expected),
                    }
                    const policy = await OrganizationRecovery.reconstruct({
                      source: current,
                      target: policyTarget,
                      queued: queuedFacts,
                    })
                    const physical = await OrganizationSourceRetirement.complete(policy.source)
                    await OrganizationRecovery.publishReconciled({
                      source: physical,
                      target: policyTarget,
                      namespace: captured.namespace,
                      native: captured.native,
                      keys,
                      writers: [inspection],
                      queued: queuedFacts,
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
        await HomeOwnershipFile.open({
          root: selected.home.root,
          env: { SYNERGY_TEST_HOME: selected.home.home },
        }).read(),
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
      expect((await selected.service.service.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe(
        "released",
      )
      phase("all-assertions-complete")
      return
    }
    await target.run(() => OrganizationRecovery.completeServicePublication(original.installationID))
    if (!retiredReference || !hostedMaterial) throw new Error("Missing original retired Hosted material")
    const reference = retiredReference
    const material = hostedMaterial
    const hostedRequest = OrganizationHostedRecovery.request({
      restoreID: roundID("restored-hosted"),
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
    {
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
        const work = OrganizationHostedRecovery.complete(
          (await HomeRestoration.inspect(publishing.target)).installationID,
        )
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
    }
    phase("hosted-completion-verified")
    await target.close()
    phase("target-closed")
    await selected.service.service.close()
    phase("source-service-closed")
    if (cloud) await cloud.removeOriginalObjects()
    await selected.service.stopListener()
    phase("source-listener-stopped")
    const normalService = await openOrganizationService({
      home: path.join(await fs.realpath(selected.service.root), "retirement-service-target"),
      ...(cloud ? { cloud: cloud.targetCloud } : {}),
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
    let verifyRecoveryRequest: ((request: Request) => Promise<void>) | undefined
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
      fetch:
        history === "failed-root-continue"
          ? async (request, server) => {
              if (verifyRecoveryRequest) await verifyRecoveryRequest(request)
              return normalService.fetch(request, server)
            }
          : normalService.fetch,
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
    await using ordinary = await (
      history === "failed-root-continue" ||
        history === "paused-queued-recovery" ||
        history === "member-handoff-failed-root"
        ? openNativeFixture
        : openHostedRuntime
    )({
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
      expect(original.status).toBe(
        history === "failed-root-continue" || history === "member-handoff-failed-root" ? "failed" : "completed",
      )
      expect(original.id).toBe(task.accepted.effect.messageID)
      if (!originalInput || originalInput.info.role !== "user")
        throw new Error("Expected the original accepted native user input")
      expect(originalInput.info.actor).toMatchObject({
        kind: "account",
        subjectID: task.accepted.permit.actor.subjectID,
      })
      const input = await ordinary.run(() => MessageV2.get({ sessionID: recovered.id, messageID: original.id }))
      if (input.info.role !== "user") throw new Error("Restored root changed its original input role")
      expect(input.info.actor).toEqual(originalInput.info.actor)
      expect(task.calls.length).toBe(originalCalls)
    }
    if (cloud) {
      if (!cloudSelection || !task) throw new Error("Missing original selected cloud recovery history")
      await cloud.verify(selected.service, normalService, cloudSelection)
      expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
      expect(task.calls.length).toBe(originalCalls)
    }
    if (sharedHistory) {
      await sharedHistory.verifyService(normalService)
      await sharedHistory.verifyNative(ordinary)
      phase("restored-unshared-generation-verified")
    }
    if (queuedHistory && task) {
      const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
      expect(
        await ordinary.run(() => RolloutLedger.getRun(owner, queuedHistory.accepted.effect.messageID)),
      ).toMatchObject({
        id: queuedHistory.accepted.effect.messageID,
        status: "completed",
        recording: "complete",
      })
      const retained = await ordinary.run(() =>
        MessageV2.get({ sessionID: task.sessionID, messageID: queuedHistory.accepted.effect.messageID }),
      )
      if (retained.info.role !== "user") throw new Error("Restored queued task lost its original input")
      expect(retained.info.actor).toMatchObject({
        kind: "account",
        subjectID: queuedHistory.accepted.permit.actor.subjectID,
        requestID: queuedHistory.accepted.permit.requestID,
      })
      expect(await ordinary.run(() => RolloutLedger.tools(owner, queuedHistory.accepted.effect.messageID))).toEqual([])
      expect(task.calls).toHaveLength(originalCalls)
      expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
    }
    if (terminalCancel && task) {
      const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
      const run = await ordinary.run(() => RolloutLedger.getRun(owner, terminalCancel.runID))
      expect(run).toMatchObject({ id: terminalCancel.runID, status: "completed", recording: "complete" })
      expect(run.cancelRequestedAt).toBeUndefined()
      expect(await ordinary.run(() => RolloutLedger.tools(owner, terminalCancel.runID))).toEqual([])
      expect(task.calls).toHaveLength(terminalCancel.baseline)
      expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
    }
    if (failedKnowledge)
      await failedKnowledge.verify({
        ...selected,
        runtime: ordinary,
        service: { ...selected.service, service: normalService },
      })
    if (settledQuestion && task) {
      const receipt = await ordinary.run(() =>
        ScopeContext.provide({
          scope: task.info.scope,
          workspace: null,
          fn: () => Question.reconcile({ sessionID: task.sessionID, requestID: settledQuestion.requestID }),
        }),
      )
      expect(receipt).toEqual(settledQuestion.receipt)
      const owner = { kind: "session" as const, scopeID: task.info.scope.id, sessionID: task.sessionID }
      expect(await ordinary.run(() => RolloutLedger.tools(owner, task.nativeRelease.rootID))).toEqual([])
      const pending = await ordinary.run(() =>
        ScopeContext.provide({ scope: task.info.scope, workspace: null, fn: () => Question.list() }),
      )
      expect(pending.some((item) => item.id === settledQuestion.requestID)).toBe(false)
      expect(task.calls).toHaveLength(settledQuestion.baseline)
      expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
    }
    if ((history === "member-handoff" || history === "member-handoff-failed-root") && task) {
      if (!handedOff) throw new Error("Missing the actual completed Member Handoff history")
      const proof = handedOff.handoffHistory
      expect(
        await normalService.maintenance.run(() => Storage.read(["organization", "handoffs", proof.handoffID])),
      ).toEqual(proof.serviceRecord)
      expect(await ordinary.run(() => proof.inspectEpoch())).toEqual(proof.targetEpoch)
      expect(task.calls).toHaveLength(originalCalls)
      expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
    }
    if (
      (history === "failed-root-continue" ||
        history === "paused-queued-recovery" ||
        history === "member-handoff-failed-root") &&
      task
    ) {
      if (queuedCapture) {
        if (!queuedEntries) throw new Error("Missing the actual captured queued cleanup roster")
        const actual = await ordinary.run(async () =>
          (await OrganizationExecutionLeases.captureEntries()).filter(
            (entry) =>
              entry.authority.sessionID === task.sessionID &&
              entry.authority.rootID === queuedCapture.accepted.effect.messageID,
          ),
        )
        expect(actual).toEqual(queuedEntries)
      }
      expect(task.calls).toHaveLength(originalCalls)
      expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
      await ordinary.run(async () => {
        expect(ModelExecution.mode()).toBe("worker")
        await AgentTurn.prewarm()
        const workers = AgentTurn.stats()
        expect(workers.minIdle).toBeGreaterThan(0)
        expect(workers.ready).toBeGreaterThanOrEqual(workers.minIdle)
      })
      expect(task.calls).toHaveLength(originalCalls)
      const login = await selected.service.client.orgAuth.login(
        { orgLoginInput: { loginName: "owner", password: "a long integration password" } },
        { throwOnError: true },
      )
      const cookie = login.response.headers.get("set-cookie")?.split(";")[0]
      if (!cookie) throw new Error("The restored Continue lacks its original current account login")
      expect(login.data.account.accountID).toBe(task.accepted.permit.actor.subjectID)
      ordinaryHeaders = { cookie, "x-csrf-token": login.data.csrfToken }
      await using authority =
        history === "failed-root-continue"
          ? recoveryContinuationAuthority({
              service: normalService,
              origin: selected.service.origin,
              ca: selected.service.ca,
              root: path.join(selected.service.root, "hosted-target", ".synergy"),
              publicKey: selected.home.publicKey,
              sessionID: task.sessionID,
              rootID: task.nativeRelease.rootID,
              modelCalls: () => task.calls.length,
            })
          : undefined
      if (authority) verifyRecoveryRequest = authority.before
      try {
        const continued = await continueRestoredHostedTask(
          {
            ...selected,
            runtime: ordinary,
            service: {
              ...selected.service,
              service: normalService,
              headers: { cookie, "x-csrf-token": login.data.csrfToken },
            },
          },
          task,
          queuedCapture,
        )
        if (history === "member-handoff-failed-root") {
          if (!handedOff) throw new Error("Missing actual recovered Native Handoff task")
          await verifyRecoveredHandoffTaskHistory(
            {
              ...selected,
              runtime: ordinary,
              service: { ...selected.service, service: normalService },
            },
            task,
            continued,
            handedOff.handoffHistory.handoffID,
          )
        }
      } catch (error) {
        if (authority) {
          try {
            await authority.assertQualified()
          } catch (qualification) {
            throw new AggregateError(
              [error, qualification],
              "Restored Continue and original machine authority controls failed",
            )
          }
        }
        throw error
      } finally {
        verifyRecoveryRequest = undefined
      }
      if (authority) await authority.assertQualified()
      if (history === "paused-queued-recovery") {
        if (!queuedCapture) throw new Error("Second capture requires the actual recovered queued input")
        const closedCalls = task.calls.length
        const closedEntries = await ordinary.run(() => OrganizationExecutionLeases.captureEntries())
        expect(closedEntries.every((entry) => entry.state === "settled")).toBe(true)
        expect(await ordinary.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
        const recovered = closedEntries.filter(
          (entry) =>
            entry.authority.sessionID === task.sessionID &&
            entry.authority.rootID === queuedCapture.accepted.effect.messageID &&
            entry.settlement?.kind === "recovered",
        )
        expect(recovered).toHaveLength(1)
        const linkage = recovered[0]!.settlement
        if (linkage?.kind !== "recovered")
          throw new Error("Second capture lost its actual original queued cleanup bridge")
        const firstSuccessor = closedEntries.find((entry) => entry.entryID === linkage.entryID)
        if (!firstSuccessor) throw new Error("Second capture lost its actual current cleanup entry")
        let successor: OrganizationExecutionLeases.Entry = firstSuccessor
        const authority = successor.authority
        const visited = new Set<string>()
        while (successor.settlement?.kind === "linked") {
          if (visited.has(successor.entryID)) throw new Error("Second capture found a cleanup linkage cycle")
          visited.add(successor.entryID)
          expect(successor.authority).toEqual(authority)
          const linkedEntryID = successor.settlement.entryID
          const next = closedEntries.find((entry) => entry.entryID === linkedEntryID)
          if (!next) throw new Error("Second capture lost an original generation link")
          successor = next
        }
        expect(successor.authority).toEqual(authority)
        expect(successor).toMatchObject({
          state: "settled",
          authority: { rootID: queuedCapture.accepted.effect.messageID },
          settlement: {
            kind: "terminal",
            receipt: { outcome: "completed", rootID: queuedCapture.accepted.effect.messageID },
          },
        })
        const marker = () =>
          HomeOwnershipFile.open({
            root: RuntimeContext.current().host.root,
            env: RuntimeContext.current().host.env,
          }).read()
        const [serviceOwner, hostedOwner] = await Promise.all([
          normalService.maintenance.run(marker),
          ordinary.run(marker),
        ])
        expect(serviceOwner).toMatchObject({ schemaVersion: 3, owner: "organization" })
        expect(hostedOwner).toMatchObject({
          schemaVersion: 3,
          owner: "organization-runtime",
          readerContract: NativeHomeReaderContract,
        })
        let participants = 0
        phase("restored-queued-second-capture-enter")
        const second = await Cohort.capture({
          service: Cohort.service(normalService.maintenance),
          async resolve(identity) {
            expect(identity.runtimeID).toBe(selected.registration.runtimeID)
            participants++
            return Cohort.hosted(ordinary, { native: Native.capture })
          },
          directory: path.join(selected.service.root, "restored-queued-second-cohort"),
          archiveID: "restored-queued-second-cohort",
          buildVersion: "fixture",
          keys,
          actor: { ...actor, requestID: "restored-queued-second-capture" },
        })
        secondCohort = { directory: path.join(selected.service.root, "restored-queued-second-cohort"), report: second }
        expect(second).toMatchObject({ namespaceCheckpointsComplete: true, namespaces: 2 })
        expect(participants).toBe(1)
        expect((await normalService.maintenance.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
        expect((await ordinary.run(() => RuntimeMaintenance.status()))?.phase).toBe("released")
        expect(await ordinary.run(() => OrganizationExecutionLeases.captureEntries())).toEqual(closedEntries)
        expect(await ordinary.run(() => OrganizationExecutionLeases.pendingForCapture())).toBe(false)
        expect(await normalService.maintenance.run(marker)).toEqual(serviceOwner)
        expect(await ordinary.run(marker)).toEqual(hostedOwner)
        expect(task.calls).toHaveLength(closedCalls)
        expect(await ordinary.run(() => SessionManager.isRunning(task.sessionID))).toBe(false)
        phase("restored-queued-second-capture-complete")
      }
    }
    phase("all-assertions-complete")
    if (after) {
      if (!sourceNamespace) throw new Error("The original recovery lacks its actual fixed H1 namespace")
      const home = await readHostedHome(path.join(selected.service.root, "hosted-target"), selected.home.identity)
      const registration = Protocol.HostedRegistrationRecord.parse(
        await readRuntimeRegistration(home.home, home.identity),
      )
      await after({
        runtime: ordinary,
        service: normalService,
        home,
        registration,
        installationID: original.installationID,
        headers: ordinaryHeaders,
        cohort: secondCohort,
        sourceNamespace,
        async stopListener() {
          await restoredServer.stop(true)
        },
      })
    }
  }
  if (history !== "paused-queued-repeat") return await runRound(selected, history)
  if (!task) throw new Error("Repeated Hosted recovery requires its actual original task")
  await runRound(selected, "paused-queued-recovery", 1, undefined, async (reopened) => {
    if (!reopened.cohort || !reopened.headers || !reopened.home.restoration)
      throw new Error("Second recovery requires the actual B cohort, current login and completed native installation")
    const retained = await captureHostedRepeatHistory({
      service: reopened.service,
      runtime: reopened.runtime,
      task,
      installationID: reopened.installationID,
      hostedInstallationID: reopened.home.restoration.installationID,
      runtimeID: reopened.registration.runtimeID,
    })
    const root = path.join(selected.service.root, "queued-second-round")
    await fs.mkdir(root, { recursive: true })
    const capture = createHostedRecoveryCapture(reopened.runtime, root, { ...actor, requestID: "hosted-native-second" })
    let closed = false
    const actualB: HostedRecoverySource = {
      ...selected,
      home: reopened.home,
      registration: reopened.registration,
      runtime: reopened.runtime,
      service: {
        ...selected.service,
        root,
        service: reopened.service,
        headers: reopened.headers,
        stopListener: reopened.stopListener,
      },
      ...capture,
      async close() {
        if (closed) return
        await capture.releaseCapture()
        await reopened.runtime.close()
        closed = true
      },
    }
    await using actualBCleanup = {
      async [Symbol.asyncDispose]() {
        await actualB.close()
      },
    }
    phase("second-hosted-recovery-enter")
    await runRound(actualB, undefined, 2, reopened.cohort, async (current) => {
      await retained.verify({ ...current, keys })
      expect(task.calls).toHaveLength(retained.modelCalls)
      phase("second-hosted-ordinary-history-verified")
    })
    phase("second-hosted-recovery-complete")
  })
}

test(
  "a real Member task reaches the sole Hosted writer by native Handoff and survives recovery without replay",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "member-handoff"),
  90_000,
)

test(
  "a failed Member root moves by native Handoff, restores without replay and continues once through its current driver",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "member-handoff-failed-root"),
  90_000,
)

test("a recovered queued input completes and survives a second Service and Hosted recovery without replay", async () => {
  try {
    await recoverHostedWriter(true, undefined, undefined, undefined, "paused-queued-repeat")
  } catch (error) {
    observeRepeatedHostedRecoveryFailure("recovery", error)
    throw error
  }
}, 60_000)

test(
  "a failed knowledge activation retains its original selection and immutable release through full recovery without replay",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "failed-knowledge-activation"),
  60_000,
)

test(
  "a failed desired Knowledge update restores the original nonempty cache through its native facet without Source files",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "failed-knowledge-nonempty"),
  60_000,
)

test(
  "a paused accepted Hosted input stays queued while the original cohort is captured",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "paused-queued-capture"),
  60_000,
)

test(
  "a paused accepted original input survives full recovery and one current Continue consumes it once",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "paused-queued-recovery"),
  60_000,
)

test("a saved failed root restores without replay and continues once through a current public command", async () => {
  try {
    await recoverHostedWriter(true, undefined, undefined, undefined, "failed-root-continue")
  } catch (error) {
    function describe(value: unknown, depth = 0): unknown {
      if (!(value instanceof Error) || depth > 6) return String(value)
      return {
        name: value.name,
        message: value.message,
        ...("error" in value ? { error: describe(value.error, depth + 1) } : {}),
        ...("suppressed" in value ? { suppressed: describe(value.suppressed, depth + 1) } : {}),
        ...(value instanceof AggregateError
          ? { errors: value.errors.map((nested) => describe(nested, depth + 1)) }
          : {}),
        ...(value.cause ? { cause: describe(value.cause, depth + 1) } : {}),
      }
    }
    console.error("FAILED_ROOT_CONTINUE_FAILURE", JSON.stringify(describe(error)))
    throw error
  }
}, 60_000)

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

test("a Hosted Session restores its selected cloud resources and native history together without replay or compute", async () => {
  await using cloud = await hostedCloudResourceFixture()
  await recoverHostedWriter(true, undefined, undefined, cloud)
}, 60_000)

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

test(
  "a closed queued Continue history survives original Hosted recovery without replay",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "queued-continue"),
  60_000,
)

test(
  "a terminal Cancel of a completed Hosted task survives original recovery without replay",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "terminal-cancel"),
  60_000,
)

test(
  "a genuinely settled private Question survives original Hosted recovery without copying its answer to Service",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "settled-question"),
  60_000,
)

test("a signed queued roster rejects changed actual Target Inbox before publication and preserves its original fixture", async () => {
  const fault: QueuedTargetInboxFault = {
    kind: "target-inbox-revision",
    injections: 0,
    rawRestoreCompleted: false,
    rejectedBySignedRoster: false,
    originalInboxRestored: false,
    originalPermitRetained: false,
    sourceUnchanged: false,
    publicationAbsent: false,
    zeroModelReplay: false,
  }
  const outcome = await recoverHostedWriter(
    true,
    undefined,
    undefined,
    undefined,
    "paused-queued-recovery",
    fault,
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  expect(outcome.ok).toBe(false)
  expect(fault.injections).toBe(1)
  expect(fault.rawRestoreCompleted).toBe(true)
  expect(fault.rejectedBySignedRoster).toBe(true)
  expect(fault.originalInboxRestored).toBe(true)
  expect(fault.originalPermitRetained).toBe(true)
  expect(fault.sourceUnchanged).toBe(true)
  expect(fault.publicationAbsent).toBe(true)
  expect(fault.zeroModelReplay).toBe(true)
  if (outcome.ok) throw new Error("Changed Target Inbox was accepted")
  expect(outcome.error).toBe(fault.failure)
}, 60_000)

test(
  "an actually ACKed then unshared Hosted transcript survives full native recovery while remaining private",
  () => recoverHostedWriter(true, undefined, undefined, undefined, "share-ack-unshare"),
  60_000,
)
