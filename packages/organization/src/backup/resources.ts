import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { constants, fstatSync, lstatSync, realpathSync } from "node:fs"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent, WorkspaceBlobs, type BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { initializeSqliteEngine } from "@ericsanchezok/synergy-harness/storage/sqlite-engine"
import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import { OrganizationCloudResourceHistory as History } from "../cloud-history"
import { OrganizationRecord } from "../storage/records"
import type { OrganizationCloudOptions } from "../cloud"

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Profiles = z.strictObject({
  stores: z.array(z.string()).refine((value) => digest(value) === digest([...new Set(value)].sort())),
  providers: z.array(z.string()).refine((value) => digest(value) === digest([...new Set(value)].sort())),
  workspaces: z.record(z.string(), WorkspaceContent.Spec),
  environments: z.record(
    z.string(),
    z.strictObject({
      provider: Environment.Info.shape.provider,
      spec: Environment.Info.shape.spec,
      idleTimeoutMs: Environment.Info.shape.idleTimeoutMs.optional(),
      reuse: z.enum(["session", "workspace", "scope"]).optional(),
    }),
  ),
})
const configuration = RuntimeContext.state(() => ({
  value: undefined as z.infer<typeof Profiles> | undefined,
  required: false,
}))
const nativePrefix = (key: string[]) =>
  key[0] === "workspace" ||
  key[0]?.startsWith("workspace_") ||
  key[0] === "environment" ||
  key[0]?.startsWith("environment_")
const selectedPrefix = (key: string[]) => nativePrefix(key) || (key[0] === "organization" && key[1] === "cloud")
const manifestKey = ["resource-native", "manifest"]
const objectKey = (store: string, hash: string) => ["resource-native", "objects", store, hash]
function fail(message: string): never {
  throw new Error("Organization resource recovery " + message)
}
type SegmentInput = {
  directory: string
  expected: StorageCheckpoint.Manifest
  source: StorageCheckpoint.Manifest
  namespaceDirectory: string
  keys: VaultKeyProvider
  signal?: AbortSignal
}
type NativeInput = {
  archive: SnapshotMaintenance.ArchiveEvidence
  lease: RuntimeMaintenance.Lease
  directory: string
  keys: VaultKeyProvider
  signal?: AbortSignal
}
function keys(provider: VaultKeyProvider): VaultKeyProvider {
  return Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
}

export namespace OrganizationResourceNative {
  export const Manifest = z.strictObject({
    format: z.literal("synergy-organization-resource-native"),
    version: z.literal(1),
    source: StorageCheckpoint.Manifest,
    profiles: Profiles,
    workspaces: z.number().int().nonnegative().safe(),
    environments: z.number().int().nonnegative().safe(),
    records: z.number().int().nonnegative().safe(),
    recordsHash: Hash,
    heads: z.number().int().nonnegative().safe(),
    objects: z.number().int().nonnegative().safe(),
    objectBytes: z.number().int().nonnegative().safe(),
  })
  export type Manifest = z.infer<typeof Manifest>
  export interface Captured extends AsyncDisposable {
    readonly directory: string
    readonly namespace: StorageCheckpoint.Manifest
  }
  const captures = new WeakMap<
    Captured,
    { archive: SnapshotMaintenance.ArchiveEvidence; manifest: Manifest; assert(): void }
  >()
  function composition(options: OrganizationCloudOptions = {}) {
    return Profiles.parse({
      stores: Object.keys(options.blobStores ?? {}).sort(),
      providers: (options.environmentProviders ?? []).map((provider) => provider.id).sort(),
      workspaces: structuredClone(options.workspaceProfiles ?? {}),
      environments: structuredClone(options.environmentProfiles ?? {}),
    })
  }
  export function register(options: OrganizationCloudOptions = {}) {
    RuntimeContext.assertCompositionOpen("Organization native resource recovery")
    if (configuration().value) fail("composition is already registered")
    configuration().required = Object.values(options).some((value) => value && Object.keys(value).length)
    configuration().value = composition(options)
  }
  function profiles() {
    const value = configuration().value
    if (!value) fail("requires its installed native resource composition")
    return value
  }
  export function configured() {
    return !!configuration().value
  }
  export function required() {
    return configuration().required
  }
  export async function preflightComposition(
    input: Omit<SegmentInput, "namespaceDirectory">,
    target: OrganizationCloudOptions | undefined,
  ) {
    if (!target) fail("requires explicit target resource composition")
    const expected = composition(target)
    let manifest: Manifest | undefined
    for await (const entry of StorageCheckpoint.entries({
      directory: input.directory,
      expected: input.expected,
      keys: keys(input.keys),
      signal: input.signal,
    })) {
      if (entry.type === "record") {
        if (digest(entry.key) !== digest(manifestKey) || manifest) fail("contains another resource composition record")
        manifest = Manifest.parse(entry.value)
      } else if (
        entry.type !== "artifact" ||
        entry.key.length !== 4 ||
        entry.key[0] !== "resource-native" ||
        entry.key[1] !== "objects"
      )
        fail("contains an unsupported resource composition entry")
    }
    if (
      !manifest ||
      digest(manifest.source) !== digest(StorageCheckpoint.Manifest.parse(input.source)) ||
      digest(manifest.profiles) !== digest(expected)
    )
      fail("requires the exact declared target profiles and native ports")
  }
  export function assertCaptured(value: Captured, archive: SnapshotMaintenance.ArchiveEvidence) {
    const original = captures.get(value)
    if (!original || original.archive !== archive) fail("requires its original resource capture")
    original.assert()
    SnapshotMaintenance.assertArchive(archive)
    return Manifest.parse(original.manifest)
  }
  function index(filename: string) {
    initializeSqliteEngine()
    const database = new Database(filename)
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE accepted(key TEXT PRIMARY KEY); CREATE TABLE heads(store TEXT NOT NULL,spec TEXT NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(store,manifest)); CREATE TABLE objects(store TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,location TEXT,used INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(store,hash))",
    )
    return database
  }
  function reader(database: Database, assert: () => void): OrganizationRecord.HistoricalReader {
    return {
      read(schema, key) {
        assert()
        const row = database
          .query<{ value: string }, [string]>("SELECT value FROM records WHERE key=?")
          .get(JSON.stringify(key))
        if (!row) fail("is missing an original canonical record")
        return schema.parse(JSON.parse(row.value))
      },
      *entries(prefix) {
        const start = JSON.stringify(prefix).slice(0, -1) + ","
        using rows = database.prepare<{ key: string; value: string }, [string, string]>(
          "SELECT key,value FROM records WHERE key>=? AND key<? ORDER BY key",
        )
        for (const row of rows.iterate(start, start + "\uffff")) {
          assert()
          yield { key: JSON.parse(row.key), value: JSON.parse(row.value) }
        }
      },
    }
  }
  function describe(database: Database, assert: () => void) {
    const source = reader(database, assert)
    using accept = database.query("INSERT OR IGNORE INTO accepted VALUES(?)")
    const counts = History.accept(source, (key) => {
      assert()
      accept.run(JSON.stringify(key))
    })
    const hash = createHash("sha256")
    let records = 0
    using selected = database.query<{ key: string; value: string }, []>(
      "SELECT r.key,r.value FROM records r JOIN accepted a USING(key) ORDER BY r.key",
    )
    for (const row of selected.iterate()) {
      assert()
      hash.update(JSON.stringify([JSON.parse(row.key), JSON.parse(row.value)]) + "\n")
      records++
    }
    using all = database.query<{ key: string }, []>(
      "SELECT key FROM records WHERE key NOT IN(SELECT key FROM accepted)",
    )
    const unsupported = new Set<string>()
    for (const row of all.iterate()) {
      const key = z.array(z.string()).parse(JSON.parse(row.key))
      if (selectedPrefix(key)) unsupported.add(key[0] === "organization" ? "organization/cloud" : key[0]!)
    }
    if (unsupported.size) fail("contains an unsupported native resource owner: " + [...unsupported].sort().join(", "))
    using head = database.query("INSERT OR IGNORE INTO heads VALUES(?,?,?)")
    for (const { value } of source.entries(["workspace_content"])) {
      const ref = History.ContentReference.parse(value)
      const info = source.read(WorkspaceCatalog.Info, ["workspace", ref.workspaceID])
      const spec = WorkspaceContent.Spec.parse(info.backend?.spec)
      if (ref.manifest) head.run(digest(spec), JSON.stringify(spec), ref.manifest)
    }
    return { ...counts, records, recordsHash: hash.digest("hex") }
  }
  async function archived(
    database: Database,
    input: Pick<SegmentInput, "namespaceDirectory" | "source" | "keys" | "signal">,
    assert: () => void,
  ) {
    using add = database.query("INSERT INTO records VALUES(?,?)")
    for await (const entry of StorageCheckpoint.entries({
      directory: input.namespaceDirectory,
      expected: input.source,
      keys: input.keys,
      signal: input.signal,
    })) {
      assert()
      if (entry.type === "record") add.run(JSON.stringify(entry.key), JSON.stringify(entry.value))
    }
    assert()
    return describe(database, assert)
  }
  async function withIndex<T>(body: (database: Database) => Promise<T>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-resource-recovery-"))
    const database = index(path.join(directory, "index.sqlite"))
    try {
      return await body(database)
    } finally {
      database.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
  export async function assertSupported() {
    profiles()
    const assert = WorkspaceContent.captureOwner()
    await withIndex(async (database) => {
      using add = database.query("INSERT INTO records VALUES(?,?)")
      await Storage.snapshot(async (tx) => {
        for await (const entry of tx.exportEntries())
          if (entry.type === "record") {
            assert()
            add.run(JSON.stringify(entry.key), JSON.stringify(entry.value))
          }
      })
      const metadata = describe(database, assert)
      assertProfiles(database, profiles(), assert)
      return metadata
    })
  }
  function assertProfiles(database: Database, expected: z.infer<typeof Profiles>, assert: () => void) {
    if (digest(profiles()) !== digest(expected)) fail("requires the original resource profiles and native ports")
    const source = reader(database, assert)
    for (const { value } of source.entries(["workspace"])) {
      const info = WorkspaceCatalog.Info.parse(value),
        spec = WorkspaceContent.Spec.parse(info.backend?.spec)
      const meta = z
        .object({ organization: z.object({ orgID: z.string(), resourceID: z.string() }) })
        .parse(info.metadata)
      const resource = History.resource(source, meta.organization.orgID, meta.organization.resourceID)
      if (
        resource.configuration.protocol !== "workspace-storage" ||
        digest(expected.workspaces[resource.configuration.profile]) !== digest(spec)
      )
        fail("Workspace profile differs from its actual original owner")
      WorkspaceBlobs.get(spec.blobStore, spec.settings)
    }
    for (const { value } of source.entries(["environment"])) {
      const info = Environment.Info.parse(value),
        provider = EnvironmentProviders.get(info.provider)
      if (
        !Object.values(expected.environments).some(
          (profile) =>
            profile.provider === info.provider &&
            digest(provider.validateSpec?.(profile.spec) ?? profile.spec) === digest(info.spec) &&
            (profile.idleTimeoutMs ?? 600_000) === info.idleTimeoutMs,
        ) ||
        info.ownership !== (provider.ownership ?? "managed")
      )
        fail("Environment profile differs from its actual original owner")
    }
    assert()
  }
  async function directoryOwner(directory: string, assertSource: () => void) {
    assertSource()
    const file = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    let open = true
    try {
      const original = await file.stat({ bigint: true })
      const canonical = await fs.realpath(directory)
      const assert = () => {
        assertSource()
        if (!open) fail("original segment directory has closed")
        const held = fstatSync(file.fd, { bigint: true }),
          current = lstatSync(directory, { bigint: true })
        if (
          !held.isDirectory() ||
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          held.dev !== original.dev ||
          held.ino !== original.ino ||
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          realpathSync(directory) !== canonical
        )
          fail("original resource segment directory changed")
      }
      assert()
      return {
        assert,
        async close() {
          if (!open) return
          open = false
          await file.close()
        },
      }
    } catch (error) {
      open = false
      await file.close()
      throw error
    }
  }
  function captured(
    directory: string,
    namespace: StorageCheckpoint.Manifest,
    archive: SnapshotMaintenance.ArchiveEvidence,
    manifest: Manifest,
    owner: Awaited<ReturnType<typeof directoryOwner>>,
  ): Captured {
    const result = Object.freeze({ directory, namespace, [Symbol.asyncDispose]: () => owner.close() })
    captures.set(result, { archive, manifest, assert: owner.assert })
    return result
  }
  export async function capture(value: NativeInput): Promise<Captured> {
    const archive = value.archive,
      lease = value.lease,
      directory = value.directory,
      signal = value.signal,
      provider = keys(value.keys)
    if (!path.isAbsolute(directory)) fail("requires an absolute segment destination")
    const selection = SnapshotMaintenance.assertArchive(archive),
      expectedProfiles = Profiles.parse(profiles())
    const owner = WorkspaceContent.captureOwner(signal)
    const assert = () => {
      owner()
      SnapshotMaintenance.assertArchive(archive)
    }
    const frozen = async () => {
      assert()
      if ((await RuntimeMaintenance.assertHeld(lease)).phase !== "frozen") fail("requires original frozen maintenance")
      assert()
    }
    await frozen()
    return withIndex(async (database) => {
      const metadata = await archived(
        database,
        { namespaceDirectory: selection.directory, source: selection.namespace, keys: provider, signal },
        assert,
      )
      assertProfiles(database, expectedProfiles, assert)
      const existing = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      if (existing) {
        const original = await RuntimeMaintenance.assertSourcePreparationFrozen(lease)
        const held = await directoryOwner(directory, () => {
          assert()
          original()
        })
        let returned = false
        try {
          const namespace = await StorageCheckpoint.verifyArchive({ directory, keys: provider, signal })
          const manifest = await verify({
            directory,
            expected: namespace,
            source: selection.namespace,
            namespaceDirectory: selection.directory,
            keys: provider,
            signal,
          })
          if (
            digest(manifest.profiles) !== digest(expectedProfiles) ||
            manifest.recordsHash !== metadata.recordsHash ||
            manifest.records !== metadata.records ||
            manifest.workspaces !== metadata.workspaces ||
            manifest.environments !== metadata.environments
          )
            fail("existing complete segment differs from its original source")
          await frozen()
          original()
          held.assert()
          const result = captured(directory, namespace, archive, manifest, held)
          returned = true
          return result
        } finally {
          if (!returned) await held.close()
        }
      }
      const parent = path.join(RuntimeContext.current().host.root, "cache", "resource-segments")
      await fs.mkdir(parent, { recursive: true, mode: 0o700 })
      const temporary = await fs.mkdtemp(path.join(parent, "capture-"))
      let store: TransactionalStore | undefined
      try {
        store = await TransactionalStore.open({
          backend: "sqlite",
          namespace: "resource-native",
          filename: path.join(temporary, "segment.sqlite"),
        })
        const handle = { store, artifactDirectory: path.join(temporary, "artifacts") }
        using add = database.query(
          "INSERT INTO objects(store,hash,bytes) VALUES(?,?,?) ON CONFLICT(store,hash) DO NOTHING",
        )
        using find = database.query<{ bytes: number }, [string, string]>(
          "SELECT bytes FROM objects WHERE store=? AND hash=?",
        )
        using heads = database.query<{ store: string; spec: string; manifest: string }, []>(
          "SELECT store,spec,manifest FROM heads ORDER BY store,manifest",
        )
        let headCount = 0
        for (const job of heads.iterate()) {
          assert()
          const spec = WorkspaceContent.Spec.parse(JSON.parse(job.spec)),
            source = WorkspaceBlobs.get(spec.blobStore, spec.settings)
          await WorkspaceArchive.copyManifest(
            { manifest: job.manifest, source },
            {
              async put(hash, bytes) {
                assert()
                if (WorkspaceTree.hash(bytes) !== hash) fail("contains changed canonical object bytes")
                const previous = find.get(job.store, hash)
                if (previous) {
                  if (previous.bytes !== bytes.byteLength) fail("has conflicting object sizes")
                  return
                }
                await Storage.provide(handle, () => Storage.writeBinary(objectKey(job.store, hash), bytes))
                assert()
                add.run(job.store, hash, bytes.byteLength)
              },
            },
            signal,
          )
          headCount++
        }
        const totals = database
          .query<{ objects: number; objectBytes: number }, []>(
            "SELECT COUNT(*) AS objects,COALESCE(SUM(bytes),0) AS objectBytes FROM objects",
          )
          .get()!
        const manifest = Manifest.parse({
          format: "synergy-organization-resource-native",
          version: 1,
          source: selection.namespace,
          profiles: expectedProfiles,
          ...metadata,
          heads: headCount,
          ...totals,
        })
        await Storage.provide(handle, () => Storage.write(manifestKey, manifest))
        assert()
        const namespace = await Storage.provide(handle, () =>
          StorageCheckpoint.exportArchive({
            directory,
            archiveID: "resource-native",
            namespaceID: selection.namespace.namespaceID,
            buildVersion: selection.namespace.buildVersion,
            keys: provider,
            protect: () => true,
            signal,
          }),
        )
        await frozen()
        return captured(directory, namespace, archive, manifest, await directoryOwner(directory, assert))
      } finally {
        await store?.close()
        await fs.rm(temporary, { recursive: true, force: true })
      }
    })
  }
  async function withVerified<T>(
    value: SegmentInput,
    body: (value: {
      database: Database
      manifest: Manifest
      assert(): void
      source(store: string): Pick<BlobStore, "get">
    }) => Promise<T>,
  ) {
    const input = {
      ...value,
      source: StorageCheckpoint.Manifest.parse(value.source),
      expected: StorageCheckpoint.Manifest.parse(value.expected),
      keys: keys(value.keys),
    }
    let open = true
    const assert = () => {
      if (!open) fail("verified segment callback has ended")
      input.signal?.throwIfAborted()
    }
    try {
      return await withIndex(async (database) => {
        const metadata = await archived(database, input, assert)
        let manifest: Manifest | undefined
        using add = database.query("INSERT INTO objects(store,hash,bytes,location) VALUES(?,?,?,?)")
        for await (const entry of StorageCheckpoint.entries({
          directory: input.directory,
          expected: input.expected,
          keys: input.keys,
          signal: input.signal,
        })) {
          assert()
          if (entry.type === "record" && digest(entry.key) === digest(manifestKey) && !manifest) {
            manifest = Manifest.parse(entry.value)
            continue
          }
          if (
            entry.type !== "artifact" ||
            entry.key.length !== 4 ||
            entry.key[0] !== "resource-native" ||
            entry.key[1] !== "objects"
          )
            fail("contains an unsupported segment entry")
          const store = Hash.parse(entry.key[2]),
            hash = Hash.parse(entry.key[3])
          if (
            entry.location.sha256 !== hash ||
            entry.location.size > Math.max(WorkspaceTree.manifestBytes, WorkspaceTree.chunkBytes)
          )
            fail("contains a changed or oversized object")
          add.run(store, hash, entry.location.size, JSON.stringify(entry.location))
        }
        if (
          !manifest ||
          digest(manifest.source) !== digest(input.source) ||
          metadata.recordsHash !== manifest.recordsHash ||
          metadata.records !== manifest.records ||
          metadata.workspaces !== manifest.workspaces ||
          metadata.environments !== manifest.environments
        )
          fail("does not cover its complete original namespace")
        const source = (store: string): Pick<BlobStore, "get"> => ({
          async get(hash, maximum) {
            assert()
            const object = database
              .query<{ bytes: number; location: string }, [string, string]>(
                "SELECT bytes,location FROM objects WHERE store=? AND hash=?",
              )
              .get(store, hash)
            if (!object || object.bytes > maximum) fail("is missing a referenced resource object")
            const location = z
              .object({ sha256: Hash, size: z.number().int().nonnegative() })
              .passthrough()
              .parse(JSON.parse(object.location))
            const bytes = new Uint8Array(object.bytes)
            let offset = 0
            for await (const chunk of StorageCheckpoint.streamArtifact({
              directory: input.directory,
              location,
              signal: input.signal,
            })) {
              assert()
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            if (offset !== object.bytes || WorkspaceTree.hash(bytes) !== hash) fail("contains corrupt resource bytes")
            database.query("UPDATE objects SET used=1 WHERE store=? AND hash=?").run(store, hash)
            assert()
            return bytes
          },
        })
        using heads = database.query<{ store: string; manifest: string }, []>(
          "SELECT store,manifest FROM heads ORDER BY store,manifest",
        )
        let headCount = 0
        for (const head of heads.iterate()) {
          await WorkspaceArchive.verifyManifest({
            manifest: head.manifest,
            source: source(head.store),
            signal: input.signal,
          })
          assert()
          headCount++
        }
        const totals = database
          .query<{ objects: number; objectBytes: number; unreferenced: number }, []>(
            "SELECT COUNT(*) AS objects,COALESCE(SUM(bytes),0) AS objectBytes,COALESCE(SUM(used=0),0) AS unreferenced FROM objects",
          )
          .get()!
        if (
          headCount !== manifest.heads ||
          totals.objects !== manifest.objects ||
          totals.objectBytes !== manifest.objectBytes ||
          totals.unreferenced
        )
          fail("contains missing or unreferenced resource objects")
        assert()
        return await body({ database, manifest, assert, source })
      })
    } finally {
      open = false
    }
  }
  export function verify(input: SegmentInput) {
    return withVerified(input, async (value) => Manifest.parse(value.manifest))
  }
  export interface Installed {
    readonly kind: "organization-resource-native-installation"
  }
  const installed = new WeakMap<Installed, { assert(): void }>()
  export function assertInstalled(value: Installed) {
    const original = installed.get(value)
    if (!original) fail("requires its original installed resource owner")
    original.assert()
  }
  export function assertReconstruction(expected: Manifest) {
    if (digest(profiles()) !== digest(expected.profiles)) fail("requires its original target resource composition")
    for (const spec of Object.values(expected.profiles.workspaces)) WorkspaceBlobs.get(spec.blobStore, spec.settings)
    for (const spec of Object.values(expected.profiles.environments)) EnvironmentProviders.get(spec.provider)
  }
  export function withInstalled<T>(
    input: SegmentInput & { permit: HomeRestoration.InstallPermit; request: HomeRestoration.Request },
    body: (value: Installed) => Promise<T>,
  ) {
    const permit = input.permit,
      request = HomeRestoration.Request.parse(structuredClone(input.request))
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const payload = z.object({ resourcesHash: Hash }).passthrough().parse(request.payload)
    if (payload.resourcesHash !== digest(expected)) fail("segment belongs to another complete installation request")
    const assertOwner = WorkspaceContent.captureOwner(input.signal)
    HomeRestoration.assertRequest(permit, request)
    return withVerified(input, async (value) => {
      const originalProfiles = profiles()
      let open = true
      const assert = () => {
        if (!open || profiles() !== originalProfiles)
          fail("installed resource callback has ended or changed composition")
        assertOwner()
        value.assert()
        HomeRestoration.assertRequest(permit, request)
      }
      assert()
      await HomeRestoration.verifyCurrent(permit)
      assert()
      assertProfiles(value.database, value.manifest.profiles, assert)
      using heads = value.database.query<{ store: string; spec: string; manifest: string }, []>(
        "SELECT store,spec,manifest FROM heads ORDER BY store,manifest",
      )
      const ports = new Map<string, BlobStore>()
      for (const head of heads.iterate()) {
        const spec = WorkspaceContent.Spec.parse(JSON.parse(head.spec)),
          port = WorkspaceBlobs.get(spec.blobStore, spec.settings)
        ports.set(head.store, port)
        await WorkspaceArchive.copyManifest(
          { manifest: head.manifest, source: value.source(head.store) },
          {
            async put(hash, bytes) {
              assert()
              await port.put(hash, bytes)
              assert()
            },
          },
          input.signal,
        )
        await WorkspaceArchive.copyManifest(
          { manifest: head.manifest, source: port },
          {
            async put() {
              assert()
            },
          },
          input.signal,
        )
        assert()
      }
      const result = Object.freeze({ kind: "organization-resource-native-installation" as const })
      const original = {
        assert() {
          assert()
          for (const head of heads.iterate()) {
            const spec = WorkspaceContent.Spec.parse(JSON.parse(head.spec))
            if (WorkspaceBlobs.get(spec.blobStore, spec.settings) !== ports.get(head.store))
              fail("target resource port changed")
          }
        },
      }
      installed.set(result, original)
      try {
        original.assert()
        return await body(result)
      } finally {
        open = false
      }
    })
  }
}
