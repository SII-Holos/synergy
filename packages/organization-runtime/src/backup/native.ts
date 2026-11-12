import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { Global } from "@ericsanchezok/synergy-harness/global"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { OrganizationRuntimeProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { HostedIdentity, HostedBinding, ArchivedHostedBinding, ArchivedHomeReaderContract } from "../home-schema"
import { readHostedHome, runtimeIdentityDigest, runtimeHomeOrigin } from "../home"
import { captureCredentialRecord, verifyCredentialRecord } from "../credentials"
import { captureRegistrationRecord, verifyRegistrationRecord } from "../registration"
import { connectionState, verifyConnectionRecord } from "../connection-state"
import { MemberHomeError, readRecordSnapshot, parseRecord } from "../record"

export namespace OrganizationRuntimeNative {
  const NativeOwner = z.discriminatedUnion("schemaVersion", [
    HomeOwnershipFile.FencedInfo,
    HomeOwnershipFile.RestorationInfo,
  ])
  const Role = z.enum(["owner", "binding", "credentials", "registration", "connection"])
  type Role = z.infer<typeof Role>
  const File = z.strictObject({
    bytes: z.number().int().nonnegative().max(8192),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  const Startup = z.strictObject({ identity: HostedIdentity, ca: z.array(z.string().min(1)).nullable() })
  export const Manifest = z.strictObject({
    format: z.literal("synergy-organization-runtime-native"),
    version: z.literal(1),
    source: StorageCheckpoint.Manifest,
    startup: Startup,
    registration: Protocol.HostedRegistrationRecord,
    connectionEpoch: z.number().int().nonnegative().safe(),
    files: z.strictObject({
      owner: File,
      binding: File,
      credentials: File,
      registration: File,
      connection: File.optional(),
    }),
  })
  export type Manifest = z.infer<typeof Manifest>
  const state = RuntimeContext.state(() => ({ startup: undefined as z.infer<typeof Startup> | undefined }))
  const captured = new WeakMap<
    object,
    { archive: SnapshotMaintenance.ArchiveEvidence; namespace: StorageCheckpoint.Manifest; assert(): void }
  >()
  const metadataKey = ["runtime-native", "manifest"]
  const fileKey = (role: Role) => ["runtime-native", "file", role]
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  function fail(message: string): never {
    throw new MemberHomeError("Hosted native recovery " + message)
  }

  export function register(input: { identity: HostedIdentity; ca?: string | string[] }) {
    RuntimeContext.assertCompositionOpen("Hosted native recovery")
    if (state().startup) fail("startup is already registered")
    state().startup = Startup.parse({ identity: input.identity, ca: input.ca === undefined ? null : [input.ca].flat() })
    NamespaceRetirement.registerSource({
      owner: "organization-runtime",
      inspect(native, archive) {
        const selected = captured.get(native)
        if (!selected || selected.archive !== archive) fail("requires its actual captured native segment")
        selected.assert()
        return digest(Buffer.from(JSON.stringify(selected.namespace)))
      },
    })
  }

  async function records(files: ReadonlyMap<Role, Uint8Array>, startup: z.infer<typeof Startup>) {
    const required = (role: Role) => files.get(role) ?? fail("is missing " + role)
    const owner = parseRecord(required("owner"), NativeOwner, "Home ownership", 4096)
    const binding = parseRecord(required("binding"), ArchivedHostedBinding, "identity records")
    if (
      binding.state !== "ready" ||
      owner.owner !== "organization-runtime" ||
      !ArchivedHomeReaderContract.safeParse(owner.readerContract).success ||
      owner.readerContract !== binding.readerContract ||
      owner.identity !== runtimeIdentityDigest(startup.identity) ||
      runtimeIdentityDigest(binding.identity) !== owner.identity
    )
      fail("has inconsistent Home identity")
    runtimeHomeOrigin(binding.origin)
    const credentials = await verifyCredentialRecord(required("credentials"))
    if (credentials.publicKey !== binding.publicKey) fail("has mismatched machine credentials")
    const member = {
      home: "",
      root: "",
      identity: binding.identity,
      origin: binding.origin,
      publicKey: binding.publicKey,
    }
    const registration = Protocol.HostedRegistrationRecord.parse(
      verifyRegistrationRecord(required("registration"), member),
    )
    const connection = files.get("connection")
    return {
      registration,
      connectionEpoch: Math.max(
        registration.connectionEpoch,
        connection ? verifyConnectionRecord(connection, registration).connectionEpoch : 0,
      ),
    }
  }

  export function capture(input: {
    archive: SnapshotMaintenance.ArchiveEvidence
    lease: RuntimeMaintenance.Lease
    directory: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    const archive = input.archive
    const lease = input.lease
    const directory = input.directory
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const source = SnapshotMaintenance.assertArchive(archive)
    const runtime = RuntimeContext.current()
    const startup = state().startup
    if (!startup) fail("requires its actual startup settings")
    if (!path.isAbsolute(directory)) fail("destination must be absolute")
    const assert = () => {
      signal?.throwIfAborted()
      SnapshotMaintenance.assertArchive(archive)
      if (RuntimeContext.current() !== runtime || state().startup !== startup) fail("belongs to another Runtime")
    }
    const frozen = async () => {
      assert()
      if ((await RuntimeMaintenance.assertHeld(lease)).phase !== "frozen") fail("requires frozen native maintenance")
      assert()
    }
    const read = async <T>(body: () => Promise<T>) => {
      assert()
      const value = await body()
      assert()
      return value
    }
    const task = async () => {
      await frozen()
      const proof = await read(() => NativeNamespaceIdentity.capture())
      const descriptor = NativeNamespaceIdentity.inspect(proof)
      if (descriptor.owner !== "organization-runtime" || descriptor.identity.kind !== "hosted")
        fail("requires its actual Hosted namespace")
      const home = await read(() => readHostedHome(runtime.host.home, startup.identity))
      if (home.root !== runtime.host.root) fail("requires its canonical Home")
      const locks = [
        { directory: path.join(path.dirname(home.home), ".locks"), key: runtimeIdentityDigest(home.identity) },
        ...["organization-home-format", "home-ownership", "organization-enrollment", "organization-connection"].map(
          (key) => ({ directory: path.join(home.root, "state", ".locks"), key }),
        ),
      ]
      const locked = <T>(index: number, body: () => Promise<T>): Promise<T> =>
        index === locks.length ? body() : withFileLock({ ...locks[index]!, signal }, () => locked(index + 1, body))
      return locked(0, async () => {
        await frozen()
        const current = await read(() => readHostedHome(home.home, home.identity))
        const owner = await read(() =>
          readRecordSnapshot(path.join(home.root, "home-ownership.json"), NativeOwner, "Home ownership", {
            signal,
            maxBytes: 4096,
          }),
        )
        const binding = await read(() =>
          readRecordSnapshot(path.join(home.root, "organization.json"), HostedBinding, "identity records", { signal }),
        )
        const credentials = await read(() => captureCredentialRecord(home.root, { signal }))
        const registration = await read(() => captureRegistrationRecord(current, { signal }))
        if (!owner || !binding || !registration) fail("requires complete enrolled native material")
        const connection = await read(() =>
          connectionState(current, registration.value.registration).snapshot({ signal }),
        )
        const files = new Map<Role, Uint8Array>([
          ["owner", owner.bytes],
          ["binding", binding.bytes],
          ["credentials", credentials.bytes],
          ["registration", registration.bytes],
          ...(connection.record ? [["connection", connection.record.bytes] as const] : []),
        ])
        const verified = await records(files, startup)
        if (
          descriptor.identity.orgID !== verified.registration.orgID ||
          descriptor.identity.deploymentIncarnation !== verified.registration.deploymentIncarnation ||
          descriptor.identity.runtimeID !== verified.registration.runtimeID ||
          descriptor.identity.publicKey !== verified.registration.publicKey
        )
          fail("belongs to another namespace identity")
        const manifest = Manifest.parse({
          format: "synergy-organization-runtime-native",
          version: 1,
          source: source.namespace,
          startup,
          ...verified,
          files: Object.fromEntries(
            [...files].map(([role, bytes]) => [role, { bytes: bytes.byteLength, sha256: digest(bytes) }]),
          ),
        })
        const parent = path.join(Global.Path.cache, "runtime-native-segments")
        await fs.mkdir(parent, { recursive: true, mode: 0o700 })
        const temporary = await fs.mkdtemp(path.join(parent, "capture-"))
        let store: TransactionalStore | undefined
        let complete = false
        let published = false
        try {
          store = await TransactionalStore.open({
            backend: "sqlite",
            namespace: "runtime-native",
            filename: path.join(temporary, "segment.sqlite"),
          })
          const handle = { store, artifactDirectory: path.join(temporary, "artifacts") }
          await Storage.provide(handle, async () => {
            for (const [role, bytes] of files) await Storage.writeBinary(fileKey(role), bytes)
            await Storage.write(metadataKey, manifest)
          })
          assert()
          const namespace = await Storage.provide(handle, () =>
            StorageCheckpoint.exportArchive({
              directory,
              archiveID: "runtime-native",
              namespaceID: source.namespace.namespaceID,
              buildVersion: source.namespace.buildVersion,
              keys,
              signal,
              protect: () => true,
            }),
          )
          published = true
          await NativeNamespaceIdentity.verify(proof)
          await frozen()
          complete = true
          const result = Object.freeze({ directory, namespace })
          captured.set(result, { archive, namespace: StorageCheckpoint.Manifest.parse(namespace), assert })
          return result
        } finally {
          await store?.close()
          await fs.rm(temporary, { recursive: true, force: true })
          if (published && !complete) await fs.rm(directory, { recursive: true, force: true })
        }
      })
    }
    return task()
  }

  async function material(input: {
    directory: string
    expected: StorageCheckpoint.Manifest
    source: StorageCheckpoint.Manifest
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    const directory = input.directory
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    let manifest: Manifest | undefined
    const artifacts = new Map<Role, { sha256: string; size: number }>()
    for await (const entry of StorageCheckpoint.entries({ directory, expected, keys, signal })) {
      if (entry.type === "record" && JSON.stringify(entry.key) === JSON.stringify(metadataKey) && !manifest) {
        manifest = Manifest.parse(entry.value)
        continue
      }
      if (entry.type !== "artifact") fail("contains an unsupported native record")
      const role =
        entry.key.length === 3 && entry.key[0] === "runtime-native" && entry.key[1] === "file"
          ? Role.safeParse(entry.key[2])
          : undefined
      if (!role?.success || artifacts.has(role.data)) fail("contains an unsupported native record")
      artifacts.set(role.data, entry.location)
    }
    if (!manifest || JSON.stringify(manifest.source) !== JSON.stringify(source))
      fail("belongs to another namespace checkpoint")
    const files = new Map<Role, Uint8Array>()
    for (const role of Role.options) {
      const expectedFile = manifest.files[role]
      const artifact = artifacts.get(role)
      if (!expectedFile && !artifact) continue
      if (!expectedFile || !artifact || artifact.size !== expectedFile.bytes || artifact.sha256 !== expectedFile.sha256)
        fail("has missing or changed native bytes")
      const bytes = new Uint8Array(expectedFile.bytes)
      let offset = 0
      for await (const chunk of StorageCheckpoint.streamArtifact({ directory, location: artifact, signal })) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      files.set(role, bytes)
    }
    const verified = await records(files, manifest.startup)
    if (
      JSON.stringify(verified.registration) !== JSON.stringify(manifest.registration) ||
      verified.connectionEpoch !== manifest.connectionEpoch
    )
      fail("has inconsistent registration or connection state")
    return { manifest, files }
  }
  export async function verify(input: Parameters<typeof material>[0]): Promise<Manifest> {
    return (await material(input)).manifest
  }
  export async function withMaterial<T>(
    input: Parameters<typeof material>[0],
    body: (material: Material) => Promise<T>,
  ) {
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const artifacts = primary.artifactDirectory
    const objects = primary.artifactObjects
    const objectConfiguration = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    const configuration = digest(Buffer.from(JSON.stringify(store.options)))
    let open = true
    const assert = () => {
      if (
        !open ||
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        Storage.current().store !== store ||
        primary.store !== store ||
        Storage.current().artifactDirectory !== artifacts ||
        primary.artifactDirectory !== artifacts ||
        Storage.current().artifactObjects !== objects ||
        primary.artifactObjects !== objects ||
        objects?.blobs !== objectConfiguration?.blobs ||
        objects?.writerID !== objectConfiguration?.writerID ||
        objects?.now !== objectConfiguration?.now ||
        digest(Buffer.from(JSON.stringify(store.options))) !== configuration
      )
        fail("material belongs to another native callback or Store")
    }
    assert()
    const selected = await material(input)
    assert()
    const proof: Material = Object.freeze({ kind: "hosted-native-material" })
    materials.set(proof, { ...selected, assert })
    try {
      const result = await body(proof)
      assert()
      return result
    } finally {
      open = false
    }
  }
  export interface Material {
    readonly kind: "hosted-native-material"
  }
  const materials = new WeakMap<Material, { manifest: Manifest; files: Map<Role, Uint8Array>; assert(): void }>()
  export function inspectMaterial(material: Material) {
    const selected = materials.get(material)
    if (!selected) fail("requires its original verified native material")
    selected.assert()
    return {
      manifest: Manifest.parse(selected.manifest),
      files: new Map([...selected.files].map(([role, bytes]) => [role, new Uint8Array(bytes)])),
    }
  }
}
