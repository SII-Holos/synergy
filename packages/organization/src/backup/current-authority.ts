import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationServiceNative as Native } from "./service-native"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Info = z.strictObject({
  checkpoint: AuthorityJournal.Checkpoint,
  after: AuthorityJournal.Checkpoint.optional(),
  maintenance: RuntimeMaintenance.Info,
  namespaceHash: OrganizationProtocol.Digest,
  nativeHash: OrganizationProtocol.Digest,
  clientDefinitionsHash: OrganizationProtocol.Digest,
})
type Info = z.infer<typeof Info>
function fail(message: string): never {
  throw new Error("Current organization authority " + message)
}

export namespace OrganizationCurrentAuthority {
  export interface Source {
    readonly kind: "organization-current-authority"
  }
  const sources = new WeakMap<Source, { info: Info; assert(): void; verify(): Promise<void> }>()
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
        return SnapshotMaintenance.withCapture(
          async (capture) => {
            const archive = await capture.exportArchive({
              directory: path.join(directory, "records"),
              archiveID: crypto.randomUUID(),
              namespaceID: checkpoint.namespaceID,
              buildVersion,
              keys,
              protect: () => true,
              signal,
            })
            const evidence = await capture.validateArchive(archive, { signal })
            const native = await Native.capture({
              archive: evidence,
              lease,
              directory: path.join(directory, "native"),
              keys,
              signal,
            })
            let open = true
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
                if (fixed.identity.orgID !== checkpoint.namespaceID) fail("native settings belong to another namespace")
                return hash(fixed.startup.settings.clientAuthentication.clients)
              } finally {
                fixed.rawConfiguration?.fill(0)
              }
            }
            try {
              const clientDefinitionsHash = await verify()
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
                async verify() {
                  if ((await verify()) !== clientDefinitionsHash) fail("native client definitions changed")
                },
              })
              const result = await body(source)
              await verify()
              return result
            } finally {
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
