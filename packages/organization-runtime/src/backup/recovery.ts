import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { HostedIdentity, NativeHomeReaderContract } from "../home-schema"
import { runtimeIdentityDigest } from "../home"
import { registerSessionSchema } from "../session-schema"
import { parseRecord } from "../record"
import { HostedBinding } from "../home-schema"
import { OrganizationHostedPublication as Publication } from "./publication"
import { OrganizationRuntimeNative as Native } from "./native"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const TargetRequest = HomeRestoration.Request.extend({
  owner: z.literal("organization-runtime"),
  payload: z.strictObject({
    source: NamespaceRetirement.Reference,
    snapshot: z.strictObject({ manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  }),
})
const roles = {
  binding: ["organization.json"],
  credentials: ["auth", "organization-runtime.json"],
  registration: ["organization-registration.json"],
  connection: ["organization-connection.json"],
} as const
function fail(message: string): never {
  throw new Error("Hosted restoration " + message)
}

export namespace OrganizationHostedRecovery {
  export const Request = TargetRequest
  export type Request = z.infer<typeof Request>
  export function request(input: {
    restoreID: string
    source: NamespaceRetirement.Reference
    snapshot: StorageCheckpoint.Manifest
  }) {
    const source = NamespaceRetirement.Reference.parse(input.source)
    return Request.parse({
      restoreID: input.restoreID,
      owner: "organization-runtime",
      sourceHash: hash(source.archive),
      payload: { source, snapshot: { manifestHash: hash(StorageCheckpoint.Manifest.parse(input.snapshot)) } },
    })
  }
  export async function restore(input: {
    permit: HomeRestoration.InstallPermit
    request: Request
    source: NamespaceRetirement.Inspection
    namespaceDirectory: string
    native: { directory: string; expected: StorageCheckpoint.Manifest }
    snapshot: { directory: string; expected: StorageCheckpoint.Manifest }
    keys: VaultKeyProvider
    base?: StorageBootstrap.RestorationBase
    signal?: AbortSignal
  }) {
    const base = input.base
    const permit = input.permit
    const request = Request.parse(structuredClone(input.request))
    const source = input.source
    const native = {
      directory: input.native.directory,
      expected: StorageCheckpoint.Manifest.parse(input.native.expected),
    }
    const snapshot = {
      directory: input.snapshot.directory,
      expected: StorageCheckpoint.Manifest.parse(input.snapshot.expected),
    }
    const namespaceDirectory = input.namespaceDirectory
    const signal = input.signal
    const keys = Object.freeze({
      current: input.keys.current.bind(input.keys),
      resolve: input.keys.resolve.bind(input.keys),
    })
    const assert = () => {
      signal?.throwIfAborted()
      HomeRestoration.assertRequest(permit, request)
      if (hash(NamespaceRetirement.inspect(source)) !== hash(request.payload.source))
        fail("requires its original retired source")
    }
    assert()
    const reference = NamespaceRetirement.inspect(source)
    if (
      hash(reference.archive) !== request.sourceHash ||
      hash(native.expected) !== reference.nativeHash ||
      hash(snapshot.expected) !== request.payload.snapshot.manifestHash
    )
      fail("requires its original fixed namespace and facets")
    return Native.withMaterial({ ...native, source: reference.archive, keys, signal }, async (material) => {
      assert()
      const selected = Native.inspectMaterial(material)
      const registration = selected.manifest.registration
      if (
        reference.namespace.owner !== "organization-runtime" ||
        reference.namespace.identity.kind !== "hosted" ||
        reference.namespace.identity.runtimeID !== registration.runtimeID ||
        reference.namespace.identity.publicKey !== registration.publicKey ||
        reference.namespace.identity.orgID !== registration.orgID ||
        reference.namespace.identity.deploymentIncarnation !== registration.deploymentIncarnation
      )
        fail("native identity differs from its retired namespace")
      const owner = await HomeRestoration.installOwner(permit, {
        identity: runtimeIdentityDigest(selected.manifest.startup.identity),
        readerContract: NativeHomeReaderContract,
      })
      assert()
      const runtime = RuntimeContext.current()
      await FileAtomicWrite.withRoot(runtime.host.root, async (root) => {
        await HomeRestoration.verifyCurrent(permit)
        assert()
        for (const [role, relative] of Object.entries(roles)) {
          const bytes = selected.files.get(z.enum(["binding", "credentials", "registration", "connection"]).parse(role))
          const filename = path.join(runtime.host.root, ...relative)
          const previous = await fs.readFile(filename).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
          assert()
          if (previous && (!bytes || !previous.equals(bytes))) fail("cannot replace conflicting target native material")
          if (bytes && !previous) await FileAtomicWrite.write(root, [...relative], bytes)
          assert()
        }
      })
      await HomeRestoration.verifyCurrent(permit)
      await HomeOwnershipFile.open({ root: runtime.host.root, env: runtime.host.env, selected: owner }).assert({
        required: true,
      })
      assert()
      return SnapshotMaintenance.withInstalledSegment(
        { ...snapshot, source: reference.archive, namespaceDirectory, permit, request, keys, signal },
        (installed) =>
          StorageCheckpoint.restoreArchive({
            directory: namespaceDirectory,
            base,
            expected: reference.archive,
            keys,
            restoreID: request.restoreID,
            signal,
            commitGuard() {
              assert()
              SnapshotMaintenance.assertInstalledSegment(installed)
            },
            async finalize(tx, archive) {
              assert()
              await RuntimeMaintenance.adoptRestoration(tx, { permit, request, archive })
              assert()
            },
          }),
      )
    })
  }
  export function publish(input: {
    permit: HomeRestoration.InstallPermit
    request: Request
    service: HomeRestoration.PublicationInspection
    native: { directory: string; expected: StorageCheckpoint.Manifest }
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    const permit = input.permit
    const request = Request.parse(structuredClone(input.request))
    const service = input.service
    const native = {
      directory: input.native.directory,
      expected: StorageCheckpoint.Manifest.parse(input.native.expected),
    }
    const signal = input.signal
    const keys = Object.freeze({
      current: input.keys.current.bind(input.keys),
      resolve: input.keys.resolve.bind(input.keys),
    })
    const assert = () => {
      signal?.throwIfAborted()
      HomeRestoration.assertRequest(permit, request)
      Publication.registration(service, request.payload.source)
    }
    assert()
    if (hash(native.expected) !== request.payload.source.nativeHash)
      fail("requires its fixed retired source native facet")
    return Native.withMaterial(
      { ...native, source: request.payload.source.archive, keys, signal },
      async (material) => {
        assert()
        const selected = Native.inspectMaterial(material)
        const bytes = selected.files.get("binding")
        if (!bytes) fail("requires its original native binding")
        const binding = parseRecord(bytes, HostedBinding, "identity records")
        return RuntimeMaintenance.restorationTransaction(
          { permit, request },
          (tx) =>
            Publication.write(tx, {
              permit,
              request,
              source: request.payload.source,
              service,
              binding,
              credentialHash: selected.manifest.files.credentials.sha256,
              connectionEpoch: selected.manifest.connectionEpoch,
            }),
          { signal, commitGuard: assert },
        )
      },
    )
  }
  export const complete = Publication.complete
}

export async function openHostedRecovery(input: {
  home: string
  identity: HostedIdentity
  request: OrganizationHostedRecovery.Request
}) {
  if (!path.isAbsolute(input.home)) fail("requires an absolute dedicated Home")
  FileAtomicWrite.assertSupported()
  await fs.mkdir(path.join(input.home, ".synergy"), { recursive: true, mode: 0o700 })
  const home = await fs.realpath(input.home)
  const root = path.join(home, ".synergy")
  const identity = HostedIdentity.parse(structuredClone(input.identity))
  const request = OrganizationHostedRecovery.Request.parse(structuredClone(input.request))
  const context = RuntimeContext.create({ home, root, env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME } })
  return context.run(async () => {
    let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
    let store: Awaited<ReturnType<typeof StorageBootstrap.prepare>>["store"] | undefined
    let closing: Promise<void> | undefined
    const active = new Set<Promise<unknown>>()
    let accepting = true
    const close = () =>
      (closing ??= context.run(async () => {
        accepting = false
        await Promise.allSettled(active)
        const errors: unknown[] = []
        for (const stop of [
          NamespaceRetirement.stop,
          Publication.drain,
          async () => {
            Storage.closeArtifactAdmission()
            await Storage.drainArtifactPreparations()
          },
          () => store?.close(),
          () => writer?.release(),
        ]) {
          try {
            await stop()
          } catch (error) {
            errors.push(error)
          }
        }
        context.dispose()
        if (errors.length) throw new AggregateError(errors, "Hosted restoration cleanup did not complete")
      }))
    try {
      HomeRestoration.register()
      Publication.register()
      registerSessionSchema({ orgID: identity.orgID })
      RuntimeMaintenance.registerProtection()
      const selected = await HomeOwnershipFile.open({ root, env: context.host.env }).read()
      if (selected?.schemaVersion === 3) {
        if (
          selected.owner !== "organization-runtime" ||
          selected.identity !== runtimeIdentityDigest(identity) ||
          selected.readerContract !== NativeHomeReaderContract
        )
          fail("belongs to another installed identity")
        HomeOwnership.select(selected)
        await HomeRestoration.assertPendingOwner(selected)
      } else {
        HomeOwnership.select({
          owner: "organization-runtime",
          identity: runtimeIdentityDigest(identity),
          readerContract: NativeHomeReaderContract,
        })
      }
      writer = await ServerProcessLock.acquire()
      let target: HomeRestoration.Target | undefined
      const prepared = await StorageBootstrap.prepare({
        root,
        async beforeInitialize(opened) {
          context.storage = { store: opened, artifactDirectory: path.join(root, "data") }
          target = await HomeRestoration.begin(request)
        },
      })
      store = prepared.store
      if (context.storage?.store !== store) fail("bootstrap changed its original primary Store")
      await prepared.activate()
      if (!target) fail("did not retain its original native target")
      const installation = target
      RuntimeContext.sealComposition()
      return {
        target: installation,
        withRestorationBase: prepared.withRestorationBase,
        async run<T>(body: () => Promise<T>): Promise<T> {
          if (!accepting) fail("restricted target is closed")
          const work = context.run(body)
          active.add(work)
          try {
            return await work
          } finally {
            active.delete(work)
          }
        },
        close,
        [Symbol.asyncDispose]: close,
      }
    } catch (error) {
      await close()
      throw error
    }
  })
}

export async function openHostedSourceRetirement(input: {
  home: string
  identity: HostedIdentity
  reference: NamespaceRetirement.Reference
}) {
  const reference = NamespaceRetirement.Reference.parse(structuredClone(input.reference))
  const identity = HostedIdentity.parse(structuredClone(input.identity))
  if (
    !path.isAbsolute(input.home) ||
    reference.namespace.owner !== "organization-runtime" ||
    reference.namespace.identity.kind !== "hosted" ||
    reference.namespace.identity.orgID !== identity.orgID ||
    reference.owner.identity !== runtimeIdentityDigest(identity)
  )
    fail("requires its original Hosted source identity")
  const home = path.resolve(input.home)
  const root = path.join(home, ".synergy")
  const context = RuntimeContext.create({ home, root, env: { SYNERGY_TEST_HOME: process.env.SYNERGY_TEST_HOME } })
  return context.run(async () => {
    let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
    let store: Awaited<ReturnType<typeof StorageBootstrap.inspect>>
    let accepting = true
    let closing: Promise<void> | undefined
    const active = new Set<Promise<unknown>>()
    const close = () =>
      (closing ??= context.run(async () => {
        accepting = false
        await Promise.allSettled(active)
        const errors: unknown[] = []
        for (const stop of [NamespaceRetirement.stop, () => store?.store.close(), () => writer?.release()]) {
          try {
            await stop()
          } catch (error) {
            errors.push(error)
          }
        }
        context.dispose()
        if (errors.length) throw new AggregateError(errors, "Retired Hosted source cleanup did not complete")
      }))
    try {
      const marker = NamespaceRetirement.marker(reference)
      HomeOwnership.select(marker)
      await HomeOwnership.assert({ required: true })
      writer = await ServerProcessLock.acquire()
      store = await StorageBootstrap.inspect(root)
      if (!store) fail("requires its original active dataset")
      context.storage = { store: store.store, artifactDirectory: store.artifactDirectory }
      await NamespaceRetirement.read(reference)
      RuntimeContext.sealComposition()
      return {
        async run<T>(body: () => Promise<T>): Promise<T> {
          if (!accepting) fail("cold retired source is closed")
          const work = context.run(body)
          active.add(work)
          try {
            return await work
          } finally {
            active.delete(work)
          }
        },
        close,
        [Symbol.asyncDispose]: close,
      }
    } catch (error) {
      await close()
      throw error
    }
  })
}
