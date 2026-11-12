import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import {
  OrganizationProtocol,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationRecoveryArchive } from "./archive"
import { OrganizationServiceNative } from "./service-native"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const deployment = { orgID: Identity.ID, deploymentIncarnation: Identity.ID }
const Service = z.strictObject({ kind: z.literal("service"), ...deployment })
const Hosted = z.strictObject({
  kind: z.literal("hosted"),
  ...deployment,
  runtimeID: Identity.ID,
  publicKey: Runtime.PublicKey,
})
const Descriptor = z.discriminatedUnion("kind", [Service, Hosted])
type Descriptor = z.infer<typeof Descriptor>
interface Runner {
  run<T>(body: () => Promise<T>): Promise<T>
}
type NativeCapture = (input: {
  archive: SnapshotMaintenance.ArchiveEvidence
  lease: RuntimeMaintenance.Lease
  directory: string
  keys: VaultKeyProvider
  signal?: AbortSignal
}) => Promise<{ directory: string; namespace: StorageCheckpoint.Manifest }>
interface Binding {
  runner: Runner
  kind: "service" | "hosted"
  runtime?: RuntimeContext.Instance
  store?: Storage.Handle["store"]
  native?: NativeCapture
  knowledge?: NativeCapture
}
class CohortError extends Error {
  override readonly name = "OrganizationBackupCohortBlocked"
}
const bindings = new WeakMap<OrganizationBackupCohort.Source, Binding>()
function owner(source: OrganizationBackupCohort.Source) {
  const selected = bindings.get(source)
  if (!selected) throw new CohortError("Backup requires its original native namespace source")
  return selected
}
async function run<T>(source: OrganizationBackupCohort.Source, body: (identity: Descriptor) => Promise<T>) {
  const selected = owner(source)
  return selected.runner.run(async () => {
    const runtime = RuntimeContext.current()
    const store = Storage.current().store
    if ((selected.runtime && selected.runtime !== runtime) || (selected.store && selected.store !== store))
      throw new CohortError("Backup namespace source changed Runtime or primary Store")
    const writer = await ServerProcessLock.currentOwnership()
    selected.runtime = runtime
    selected.store = store
    const proof = await NativeNamespaceIdentity.capture()
    const namespace = NativeNamespaceIdentity.inspect(proof)
    if (namespace.owner !== (selected.kind === "service" ? "organization" : "organization-runtime"))
      throw new CohortError("Backup namespace requires its canonical identity owner")
    const identity = selected.kind === "service" ? Service.parse(namespace.identity) : Hosted.parse(namespace.identity)
    const result = await body(identity)
    await NativeNamespaceIdentity.verify(proof)
    await ServerProcessLock.verifyOwnership(writer)
    return result
  })
}
function same(left: Descriptor, right: Descriptor) {
  return JSON.stringify(left) === JSON.stringify(right)
}
function hostedDescriptor(record: Runtime.HostedRegistrationRecord): z.infer<typeof Hosted> {
  return Hosted.parse({
    kind: "hosted",
    orgID: record.orgID,
    deploymentIncarnation: record.deploymentIncarnation,
    runtimeID: record.runtimeID,
    publicKey: record.publicKey,
  })
}
async function required() {
  const current = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  const result: z.infer<typeof Hosted>[] = []
  for await (const entry of Storage.records({ prefix: Keys.runtimes(), limit: 128 })) {
    const registration = Record.RuntimeRegistration.parse(entry.value)
    if (registration.orgID !== current.orgID || registration.deploymentIncarnation !== current.deploymentIncarnation)
      throw new CohortError("Runtime registration belongs to another deployment")
    if (registration.runtimeKind === "hosted") result.push(hostedDescriptor(registration))
  }
  result.sort((left, right) => left.runtimeID.localeCompare(right.runtimeID))
  return result
}
async function coverage() {
  for (const prefix of [["workspace"], ["environment"]])
    if ((await Storage.queryKeys({ prefix, limit: 1 })).length)
      throw new CohortError(
        "A native resource owner segment is required for this namespace's Workspace or Environment data",
      )
}
async function* files(directory: string, relative = ""): AsyncGenerator<OrganizationRecoveryArchive.Source> {
  const entries = await fs.opendir(path.join(directory, relative))
  for await (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* files(directory, name)
      continue
    }
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new CohortError("Backup preparation contains an unsupported file")
    const filename = path.join(directory, name)
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes = 0
    const checksum = createHash("sha256")
    try {
      for (;;) {
        const buffer = new Uint8Array(4 * 1024 * 1024)
        const result = await file.read(buffer, 0, buffer.length, bytes)
        if (!result.bytesRead) break
        bytes += result.bytesRead
        checksum.update(buffer.subarray(0, result.bytesRead))
      }
    } finally {
      await file.close()
    }
    yield {
      path: name,
      bytes,
      sha256: checksum.digest("hex"),
      async *read(signal) {
        const source = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let offset = 0
        try {
          for (;;) {
            signal?.throwIfAborted()
            const buffer = new Uint8Array(4 * 1024 * 1024)
            const next = await source.read(buffer, 0, buffer.length, offset)
            if (!next.bytesRead) break
            offset += next.bytesRead
            yield buffer.subarray(0, next.bytesRead)
          }
        } finally {
          await source.close()
        }
      },
    }
  }
}

export namespace OrganizationBackupCohort {
  export interface Source {
    readonly kind: "organization-backup-namespace"
  }
  export const NamespaceInventory = z
    .strictObject({
      version: z.literal(2),
      ordinal: z.number().int().nonnegative().safe(),
      identity: Descriptor,
      namespace: StorageCheckpoint.Manifest,
      segment: z.strictObject({ namespace: StorageCheckpoint.Manifest }),
      native: StorageCheckpoint.Manifest.optional(),
      hostedNative: StorageCheckpoint.Manifest.optional(),
      hostedKnowledge: StorageCheckpoint.Manifest.optional(),
    })
    .refine(
      (value) => (value.identity.kind === "service") === !!value.native,
      "Service namespaces require their native Home segment",
    )
    .refine(
      (value) => value.identity.kind === "hosted" || (!value.hostedNative && !value.hostedKnowledge),
      "Hosted native material requires a Hosted namespace",
    )
  export type NamespaceInventory = z.infer<typeof NamespaceInventory>
  export function service(runner: Runner): Source {
    const source = Object.freeze({ kind: "organization-backup-namespace" as const })
    bindings.set(source, { runner, kind: "service" })
    return source
  }
  export function hosted(runner: Runner, options: { native?: NativeCapture; knowledge?: NativeCapture } = {}): Source {
    const source = Object.freeze({ kind: "organization-backup-namespace" as const })
    const native = options.native?.bind(options)
    const knowledge = options.knowledge?.bind(options)
    bindings.set(source, { runner, kind: "hosted", native, knowledge })
    return source
  }
  export async function capture(input: {
    service: Source
    resolve(identity: z.infer<typeof Hosted>): Promise<Source | undefined>
    directory: string
    archiveID: string
    buildVersion: string
    keys: VaultKeyProvider
    actor: ActorStamp.Info
    signal?: AbortSignal
  }) {
    const originalSignal = input.signal
    originalSignal?.throwIfAborted()
    const service = input.service
    owner(service)
    const resolver = input.resolve
    if (typeof resolver !== "function") throw new CohortError("Backup requires its original namespace resolver")
    const resolve = resolver.bind(input)
    const directory = z.string().min(1).parse(input.directory)
    if (!path.isAbsolute(directory)) throw new CohortError("Backup destination must be absolute")
    const archiveID = Identity.ID.parse(input.archiveID)
    const buildVersion = z.string().min(1).max(200).parse(input.buildVersion)
    const actor = ActorStamp.Info.parse(input.actor)
    if (actor.kind === "account") throw new CohortError("Deployment backup requires trusted Host operator authority")
    const provider = input.keys
    if (typeof provider?.current !== "function" || typeof provider.resolve !== "function")
      throw new CohortError("Backup requires its original recovery-key provider")
    const keys: VaultKeyProvider = Object.freeze({
      current: provider.current.bind(provider),
      resolve: provider.resolve.bind(provider),
    })
    const initial = await run(service, async (identity) => ({
      identity: Service.parse(identity),
      required: await required(),
    }))
    const sources = [
      {
        source: service,
        identity: initial.identity as Descriptor,
        lease: undefined as RuntimeMaintenance.Lease | undefined,
      },
    ]
    for (const identity of initial.required) {
      const source = await resolve(identity)
      if (!source) throw new CohortError("A required hosted Runtime namespace is unavailable: " + identity.runtimeID)
      await run(source, async (actual) => {
        if (!same(actual, identity))
          throw new CohortError("Hosted namespace does not match its canonical service registration")
      })
      sources.push({ source, identity, lease: undefined })
    }
    const seen = new Set<Storage.Handle["store"]>()
    for (const source of sources)
      await run(source.source, async (identity) => {
        if (!same(identity, source.identity)) throw new CohortError("Backup participant identity changed")
        const store = Storage.current().store
        if (seen.has(store)) throw new CohortError("Two backup participants refer to one native namespace")
        seen.add(store)
        await coverage()
      })
    const controller = new AbortController()
    const signal = originalSignal ? AbortSignal.any([originalSignal, controller.signal]) : controller.signal
    signal.throwIfAborted()
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
    const temporary = await fs.mkdtemp(path.join(path.dirname(directory), ".cohort-preparation-"))
    let failure: unknown
    try {
      for (const source of sources)
        await run(source.source, async () => {
          const requestID = hash(JSON.stringify([archiveID, source.identity]))
          source.lease = await RuntimeMaintenance.begin({
            purpose: "organization-backup",
            actor: { ...actor, requestID },
            requestID,
            signal,
          })
        })
      const outcomes = await Promise.allSettled(
        sources.map((source) =>
          run(source.source, async () => {
            try {
              await RuntimeMaintenance.freeze(source.lease!, await RuntimeMaintenance.drain(source.lease!, { signal }))
            } catch (error) {
              controller.abort(error)
              throw error
            }
          }),
        ),
      )
      const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
      if (errors.length) throw errors[0]
      const hold = async <T>(index: number, body: () => Promise<T>): Promise<T> =>
        index === sources.length
          ? body()
          : run(sources[index].source, () =>
              RuntimeMaintenance.withFrozen(sources[index].lease!, () => hold(index + 1, body), { signal }),
            )
      return await hold(0, async () => {
        const current = await run(service, () => required())
        if (JSON.stringify(current) !== JSON.stringify(initial.required))
          throw new CohortError("Service namespace roster changed during maintenance admission")
        for (const [ordinal, source] of sources.entries())
          await run(source.source, async (identity) => {
            if (!same(identity, source.identity)) throw new CohortError("Backup participant identity changed")
            await coverage()
            const base = path.join(temporary, "namespaces", String(ordinal).padStart(16, "0"))
            const namespaceID = hash(JSON.stringify(identity))
            const inventory = await SnapshotMaintenance.withCapture(
              async (capture) => {
                const namespace = await capture.exportArchive({
                  directory: path.join(base, "records"),
                  archiveID: hash(archiveID + ":" + ordinal),
                  namespaceID,
                  buildVersion: buildVersion,
                  keys: keys,
                  protect: () => true,
                  signal,
                })
                const segment = await capture.exportSnapshots({
                  archive: namespace,
                  directory: path.join(base, "snapshots"),
                  signal,
                })
                const hosted = owner(source.source)
                const evidence =
                  identity.kind === "service" || hosted.native || hosted.knowledge
                    ? await capture.validateArchive(namespace, { signal })
                    : undefined
                const native =
                  identity.kind === "service"
                    ? await OrganizationServiceNative.capture({
                        archive: evidence!,
                        lease: source.lease!,
                        directory: path.join(base, "native"),
                        keys,
                        signal,
                      })
                    : undefined
                const hostedCapture = hosted.native
                const hostedNative =
                  identity.kind === "hosted" && hostedCapture
                    ? await hostedCapture({
                        archive: evidence!,
                        lease: source.lease!,
                        directory: path.join(base, "hosted-native"),
                        keys,
                        signal,
                      })
                    : undefined
                if (hostedNative && hostedNative.directory !== path.join(base, "hosted-native"))
                  throw new CohortError("Hosted native capture changed its original destination")
                const hostedKnowledge =
                  identity.kind === "hosted" && hosted.knowledge
                    ? await hosted.knowledge({
                        archive: evidence!,
                        lease: source.lease!,
                        directory: path.join(base, "hosted-knowledge"),
                        keys,
                        signal,
                      })
                    : undefined
                if (hostedKnowledge && hostedKnowledge.directory !== path.join(base, "hosted-knowledge"))
                  throw new CohortError("Hosted knowledge capture changed its original destination")
                return NamespaceInventory.parse({
                  version: 2,
                  ordinal,
                  identity,
                  namespace: namespace.namespace,
                  segment: { namespace: segment.namespace },
                  native: native?.namespace,
                  hostedNative: hostedNative?.namespace,
                  hostedKnowledge: hostedKnowledge?.namespace,
                })
              },
              { signal },
            )
            await Bun.write(path.join(base, "namespace.json"), JSON.stringify(inventory))
          })
        await Bun.write(
          path.join(temporary, "cohort.json"),
          JSON.stringify({
            version: 2,
            orgID: initial.identity.orgID,
            deploymentIncarnation: initial.identity.deploymentIncarnation,
            namespaces: sources.length,
            memberCoverage: "uploaded-service-data-only",
            restoredExecution: "blocked-until-reconciled",
          }),
        )
        const archive = await OrganizationRecoveryArchive.seal({
          directory: directory,
          archiveID: archiveID,
          buildVersion: buildVersion,
          keys: keys,
          files: files(temporary),
          signal,
        })
        return { ...archive, namespaceCheckpointsComplete: true as const, namespaces: sources.length }
      })
    } catch (error) {
      failure = error
      throw error
    } finally {
      const outcomes = await Promise.allSettled(
        sources
          .filter((source) => source.lease)
          .map((source) => run(source.source, () => RuntimeMaintenance.release(source.lease!))),
      )
      const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
      await fs.rm(temporary, { recursive: true, force: true })
      if (errors.length)
        throw new AggregateError(
          failure === undefined ? errors : [failure, ...errors],
          "Backup capture retains unresolved native maintenance owners",
        )
    }
  }
}
