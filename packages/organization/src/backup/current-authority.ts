import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationCurrentAuthorityInfo as Info } from "./current-authority-schema"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationSourceRetirement as Retirement } from "./source-retirement"
import { OrganizationPendingSource } from "./pending-source"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
type Info = z.infer<typeof Info>
function fail(message: string): never {
  throw new Error("Current organization authority " + message)
}

export namespace OrganizationCurrentAuthority {
  export const pendingSource = OrganizationPendingSource.create
  export const resumeRetirement = OrganizationPendingSource.resume
  export const drainPending = OrganizationPendingSource.drain
  export const registerPendingSource = OrganizationPendingSource.register
  export interface Source {
    readonly kind: "organization-current-authority"
  }
  const sources = new WeakMap<
    Source,
    {
      info: Info
      assert(): void
      verify(): Promise<void>
      accept(work: () => Promise<Retirement.Receipt>): Promise<Retirement.Receipt>
      lease: RuntimeMaintenance.Lease
      captured: {
        namespace: { directory: string; expected: StorageCheckpoint.Manifest }
        native: { directory: string; expected: StorageCheckpoint.Manifest }
        keys: VaultKeyProvider
        signal?: AbortSignal
        assertLive(): void
      }
    }
  >()
  function original(source: Source) {
    const value = sources.get(source)
    if (!value) fail("requires original live source evidence")
    value.assert()
    return value
  }
  export function describe(source: Source): Info {
    return Info.parse(original(source).info)
  }
  export async function verify(source: Source) {
    const value = original(source)
    await value.verify()
    value.assert()
  }
  export async function withCaptured<T>(
    source: Source,
    body: (captured: {
      namespace: { directory: string; expected: StorageCheckpoint.Manifest }
      native: { directory: string; expected: StorageCheckpoint.Manifest }
      keys: VaultKeyProvider
      signal?: AbortSignal
      assertLive(): void
    }) => Promise<T>,
  ) {
    const value = original(source)
    await value.verify()
    value.assert()
    const captured = value.captured
    let open = true
    try {
      const result = await body({
        namespace: {
          directory: captured.namespace.directory,
          expected: StorageCheckpoint.Manifest.parse(captured.namespace.expected),
        },
        native: {
          directory: captured.native.directory,
          expected: StorageCheckpoint.Manifest.parse(captured.native.expected),
        },
        keys: captured.keys,
        signal: captured.signal,
        assertLive() {
          if (!open) fail("captured source callback has ended")
          captured.assertLive()
        },
      })
      value.assert()
      return result
    } finally {
      open = false
    }
  }
  export async function retirementReference(source: Source, target: z.infer<typeof OrganizationInstallationReference>) {
    const selected = OrganizationInstallationReference.parse(structuredClone(target))
    const value = original(source)
    await value.verify()
    value.assert()
    const reference = await Retirement.reference(value.info, selected)
    value.assert()
    return reference
  }
  export function retire(source: Source, input: Retirement.Reference) {
    const reference = Retirement.Reference.parse(structuredClone(input))
    const value = original(source)
    if (hash(reference.current) !== hash(value.info)) fail("retirement requires its exact verified current source")
    return value.accept(async () => {
      await value.verify()
      value.assert()
      const actual = await Retirement.reference(value.info, reference.target)
      value.assert()
      if (hash(actual) !== hash(reference)) fail("retirement requires its original physical Home and primary Store")
      await value.verify()
      const writer = await ServerProcessLock.currentOwnership()
      await ServerProcessLock.verifyOwnership(writer)
      value.assert()
      const referenceHash = Retirement.marker(reference).referenceHash
      try {
        await Storage.transaction(() => RuntimeMaintenance.reserveRetirement(value.lease, referenceHash), {
          commitGuard() {
            value.assert()
            ServerProcessLock.assertCurrent(writer)
          },
        })
      } catch (error) {
        const retained = await RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)
        if (!retained || retained.referenceHash !== referenceHash) throw error
      }
      return Retirement.complete(reference)
    })
  }
  export const describeRetirement = Retirement.describe
  export const verifyRetirement = Retirement.verify
  export async function withSource<T>(
    input: {
      lease: RuntimeMaintenance.Lease
      directory: string
      buildVersion: string
      keys: VaultKeyProvider
      after?: AuthorityJournal.Checkpoint
      signal?: AbortSignal
    },
    body: (source: Source) => Promise<T>,
  ): Promise<T> {
    const lease = input.lease
    const directory = input.directory
    const buildVersion = z.string().min(1).max(200).parse(input.buildVersion)
    const after = input.after && AuthorityJournal.Checkpoint.parse(structuredClone(input.after))
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const store = handle.store
    const configuration = hash(store.options)
    const artifacts = handle.artifactDirectory
    const objects = handle.artifactObjects
    const ports = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    if (!path.isAbsolute(directory)) fail("capture destination must be absolute")
    const assertOwner = () => {
      signal?.throwIfAborted()
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage !== handle ||
        Storage.current() !== handle ||
        handle.store !== store ||
        hash(store.options) !== configuration ||
        handle.artifactDirectory !== artifacts ||
        handle.artifactObjects !== objects ||
        objects?.blobs !== ports?.blobs ||
        objects?.writerID !== ports?.writerID ||
        objects?.now !== ports?.now
      )
        fail("requires its original native Runtime and primary Store")
    }
    assertOwner()
    return RuntimeMaintenance.withFrozen(
      lease,
      async () => {
        const maintenance = await RuntimeMaintenance.assertHeld(lease)
        assertOwner()
        const current = await AuthorityJournal.inspect()
        assertOwner()
        if (!current.covered || !current.head) fail("requires complete live policy coverage")
        const checkpoint = current.head
        const proof = await NativeNamespaceIdentity.capture()
        const descriptor = NativeNamespaceIdentity.inspect(proof)
        if (descriptor.owner !== "organization" || descriptor.identity.kind !== "service")
          fail("requires its actual native service namespace")
        const identity = Native.Manifest.shape.identity.parse({
          orgID: descriptor.identity.orgID,
          deploymentIncarnation: descriptor.identity.deploymentIncarnation,
        })
        if (identity.orgID !== checkpoint.namespaceID)
          fail("native service identity differs from its logical authority")
        const namespaceID = Native.serviceNamespaceID(identity)
        await NativeNamespaceIdentity.verify(proof)
        assertOwner()
        return SnapshotMaintenance.withCapture(
          async (capture) => {
            const recordsDirectory = path.join(directory, "records")
            const nativeDirectory = path.join(directory, "native")
            const present = async (directory: string) =>
              fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error
              })
            const records = await present(recordsDirectory)
            const nativeFacet = await present(nativeDirectory)
            if (records || nativeFacet) {
              await RuntimeMaintenance.assertSourcePreparationFrozen(lease)
              const parent = await fs.lstat(directory)
              if (
                !parent.isDirectory() ||
                parent.isSymbolicLink() ||
                (await fs.realpath(directory)) !== directory ||
                (records && (!records.isDirectory() || records.isSymbolicLink())) ||
                (nativeFacet && (!nativeFacet.isDirectory() || nativeFacet.isSymbolicLink())) ||
                !records
              )
                fail("incomplete native facets require their original preparation owner")
            }
            const archive = records
              ? await capture.reopenSourcePreparationArchive({ lease, directory: recordsDirectory, keys, signal })
              : await capture.exportArchive({
                  directory: path.join(directory, "records"),
                  archiveID: crypto.randomUUID(),
                  namespaceID,
                  buildVersion,
                  keys,
                  protect: () => true,
                  signal,
                })
            if (archive.namespace.namespaceID !== namespaceID)
              fail("captured namespace has another native service identity")
            const evidence = await capture.validateArchive(archive, { signal })
            const native = await Native.capture({
              archive: evidence,
              lease,
              directory: path.join(directory, "native"),
              keys,
              signal,
            })
            await NativeNamespaceIdentity.verify(proof)
            assertOwner()
            let open = true
            let accepting = true
            const accepted = new Set<Promise<Retirement.Receipt>>()
            const assert = () => {
              if (!open) fail("source callback has ended")
              assertOwner()
              SnapshotMaintenance.assertArchive(evidence)
            }
            const verify = async () => {
              assert()
              const held = await RuntimeMaintenance.assertHeld(lease)
              assert()
              if (hash(held) !== hash(maintenance)) fail("source maintenance changed")
              const live = await AuthorityJournal.inspect()
              assert()
              if (!live.covered || hash(live.head) !== hash(checkpoint)) fail("live source policy changed")
              const archived = await AuthorityJournal.readArchivedCheckpoint({
                directory: archive.directory,
                expected: archive.namespace,
                keys,
                signal,
                after,
              })
              assert()
              if (hash(archived) !== hash(checkpoint)) fail("captured namespace has another authority head")
              const fixed = await Native.verify({
                directory: native.directory,
                expected: native.namespace,
                source: archive.namespace,
                keys,
                signal,
              })
              try {
                assert()
                if (
                  fixed.identity.orgID !== checkpoint.namespaceID ||
                  hash(fixed.identity) !== hash(identity) ||
                  Native.serviceNamespaceID(fixed.identity) !== archive.namespace.namespaceID
                )
                  fail("native settings belong to another namespace")
                return hash(fixed.startup.settings.clientAuthentication.clients)
              } finally {
                fixed.rawConfiguration?.fill(0)
              }
            }
            try {
              const clientDefinitionsHash = await verify()
              await NativeNamespaceIdentity.verify(proof)
              assertOwner()
              const source: Source = Object.freeze({ kind: "organization-current-authority" })
              sources.set(source, {
                info: Info.parse({
                  checkpoint,
                  after,
                  maintenance,
                  namespaceHash: Native.sourceHash(archive.namespace),
                  nativeHash: Native.sourceHash(native.namespace),
                  clientDefinitionsHash,
                }),
                assert,
                lease,
                captured: {
                  namespace: { directory: archive.directory, expected: archive.namespace },
                  native: { directory: native.directory, expected: native.namespace },
                  keys,
                  signal,
                  assertLive() {
                    signal?.throwIfAborted()
                    if (
                      !open ||
                      runtime.storage !== handle ||
                      handle.store !== store ||
                      hash(store.options) !== configuration ||
                      handle.artifactDirectory !== artifacts ||
                      handle.artifactObjects !== objects ||
                      objects?.blobs !== ports?.blobs ||
                      objects?.writerID !== ports?.writerID ||
                      objects?.now !== ports?.now
                    )
                      fail("captured source lifetime or native primary Store changed")
                  },
                },
                accept(body) {
                  if (!accepting) fail("source callback no longer accepts retirement work")
                  assert()
                  const work = body()
                  accepted.add(work)
                  return work
                },
                async verify() {
                  if ((await verify()) !== clientDefinitionsHash) fail("native client definitions changed")
                },
              })
              const outcome = await body(source).then(
                (value) => ({ kind: "success" as const, value }),
                (error: unknown) => ({ kind: "failure" as const, error }),
              )
              accepting = false
              const completed = await Promise.allSettled([...accepted])
              const failures = completed.filter((result) => result.status === "rejected").map((result) => result.reason)
              if (outcome.kind === "failure") failures.unshift(outcome.error)
              const errors = [...new Set(failures)]
              if (errors.length === 1) throw errors[0]
              if (errors.length) throw new AggregateError(errors, "Current source retirement did not complete")
              if (outcome.kind !== "success") fail("source callback failed")
              await verify()
              return outcome.value
            } finally {
              accepting = false
              await Promise.allSettled([...accepted])
              open = false
            }
          },
          { signal },
        )
      },
      { signal },
    )
  }
}
