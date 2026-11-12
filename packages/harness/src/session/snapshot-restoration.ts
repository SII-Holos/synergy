import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { HomeRestoration } from "../lifecycle/home-restoration"
import { HomeOwnershipFile } from "../lifecycle/home-ownership-file"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { StorageCheckpoint } from "../storage/checkpoint"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import { upgradeImportedRecord } from "../migration/import"
import { SnapshotCheckpoint } from "./snapshot-checkpoint"
import { SnapshotSegment } from "./snapshot-segment"
import { SnapshotStore } from "./snapshot-store"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotTransfer } from "./snapshot-transfer"
import { SnapshotLease } from "./snapshot-lease"
import { SnapshotRecords } from "./snapshot-records"
import { StoredSnapshotContent as Content } from "./stored-snapshot-content"

export namespace SnapshotRestoration {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  const Facet = z.object({ snapshot: z.strictObject({ manifestHash: Hash }) })
  const Reference = z.strictObject({
    version: z.literal(1),
    installationID: z.uuid(),
    requestHash: Hash,
    sourceHash: Hash,
    segmentHash: Hash,
    groupHash: Hash,
    closureHash: Hash,
  })
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const manifestHash = (value: StorageCheckpoint.Manifest) => digest(StorageCheckpoint.Manifest.parse(value))
  function fail(message: string): never {
    throw new SnapshotStore.StorageError("Snapshot installation " + message)
  }
  export const reference = (repository: string) => path.join(repository, "synergy-restoration.json")
  export interface Installed {
    readonly manifest: Readonly<SnapshotSegment.Manifest>
    readonly signal: AbortSignal
    assertCurrent(): void
    verify(): Promise<void>
  }
  const installed = new WeakMap<Installed, { assert(): void; verify(): Promise<void> }>()
  export function assertInstalled(value: Installed) {
    const original = installed.get(value)
    if (!original) fail("requires original native evidence")
    original.assert()
  }
  export async function verifyInstalled(value: Installed) {
    assertInstalled(value)
    await installed.get(value)!.verify()
    assertInstalled(value)
  }
  async function directoryIdentity(directory: string) {
    const info = await fs.lstat(directory, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
      fail("requires ordinary canonical target directories")
    return `${info.dev}:${info.ino}`
  }
  async function directories(root: string, destination: string, assert: () => void) {
    if (destination !== root && !destination.startsWith(root + path.sep)) fail("repository escapes its native owner")
    let current = root
    for (const component of ["", ...path.relative(root, destination).split(path.sep).filter(Boolean)]) {
      if (component) current = path.join(current, component)
      assert()
      await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
      assert()
      await directoryIdentity(current)
      assert()
    }
  }
  async function nativeFile(filename: string, maximum: number, assert: () => void) {
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const initial = await file.stat()
      if (!initial.isFile() || initial.size > maximum) fail("native reference is not a bounded ordinary file")
      const buffer = Buffer.alloc(maximum + 1)
      let length = 0
      for (;;) {
        assert()
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        assert()
        length += bytesRead
        if (length > maximum) fail("native reference exceeds its format")
        if (!bytesRead) break
      }
      const final = await file.stat()
      const current = await fs.lstat(filename)
      assert()
      if (
        initial.dev !== current.dev ||
        initial.ino !== current.ino ||
        initial.size !== final.size ||
        final.mtimeMs !== initial.mtimeMs ||
        current.isSymbolicLink()
      )
        fail("native reference changed while reading")
      return buffer.subarray(0, length).toString("utf8")
    } finally {
      await file.close()
    }
  }
  async function standalone(repository: string, assert: () => void) {
    await SnapshotStore.assertStandalone(repository)
    const walk = async (directory: string) => {
      for await (const entry of await fs.opendir(directory)) {
        assert()
        if (entry.isSymbolicLink()) fail("repository has an external native dependency")
        if (entry.isDirectory()) await walk(path.join(directory, entry.name))
        else if (!entry.isFile()) fail("repository has an unsupported native entry")
      }
    }
    await walk(repository)
    assert()
  }
  async function closure(
    repository: string,
    signal: AbortSignal | undefined,
    assert: () => void,
    expectedConfiguration?: string,
  ) {
    assert()
    await standalone(repository, assert)
    const checksum = createHash("sha256")
    const configurationHash = digest(await nativeFile(path.join(repository, "config"), 64 * 1024, assert))
    if (expectedConfiguration && configurationHash !== expectedConfiguration)
      fail("private repository configuration changed")
    checksum.update(configurationHash)
    checksum.update(JSON.stringify(await nativeFile(path.join(repository, "HEAD"), 1024 * 1024, assert)))
    await SnapshotGit.checked(repository, ["fsck", "--full", "--no-reflogs"], { signal })
    assert()
    // Provenance: https://git-scm.com/docs/git-cat-file#Documentation/git-cat-file.txt---batch-all-objects
    // Git supplies hash-ordered all-object identities, including unreachable history, without a resident set.
    for (const args of [
      ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)"],
      ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    ]) {
      checksum.update(JSON.stringify(args))
      for await (const line of SnapshotGit.lines(repository, args, { signal })) {
        assert()
        checksum.update(line + "\n")
      }
    }
    assert()
    return { hash: checksum.digest("hex"), configurationHash }
  }
  async function synchronize(directory: string) {
    if (process.platform === "win32") return
    const file = await fs.open(directory, "r")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }

  export async function withInstalled<T>(
    input: Parameters<typeof SnapshotCheckpoint.withRestoredSegment>[0] & {
      namespaceDirectory: string
      permit: HomeRestoration.InstallPermit
      request: HomeRestoration.Request
    },
    body: (value: Installed) => Promise<T>,
  ) {
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const facet = Facet.parse(request.payload)
    const source = StorageCheckpoint.Manifest.parse(input.source)
    const expected = StorageCheckpoint.Manifest.parse(input.expected)
    const directory = input.directory
    const namespaceDirectory = input.namespaceDirectory
    const signal = input.signal
    const provider = input.keys
    const keys = Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) })
    const identity = HomeRestoration.describe(permit)
    if (
      identity.sourceHash !== manifestHash(source) ||
      request.sourceHash !== manifestHash(source) ||
      facet.snapshot.manifestHash !== manifestHash(expected)
    )
      fail("requires its original fixed namespace and Snapshot facet")
    const runtime = RuntimeContext.current()
    const handle = Storage.current()
    const store = handle.store
    const artifacts = handle.artifactDirectory
    let active = true
    let assertPrepared: (() => void) | undefined
    const assert = () => {
      signal?.throwIfAborted()
      if (!active) fail("callback is closed")
      assertPrepared?.()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertRequest(permit, request)
      if (
        RuntimeContext.current() !== runtime ||
        Storage.current().store !== store ||
        Storage.current().artifactDirectory !== artifacts ||
        Storage.current().artifactObjects !== undefined
      )
        fail("belongs to another native target")
    }
    assert()
    await HomeRestoration.verifyCurrent(permit)
    assert()
    const ownership = await HomeOwnershipFile.open({ root: runtime.host.root, env: runtime.host.env }).read()
    if (ownership?.schemaVersion !== 3) fail("requires the permanent native Home reader fence")
    await HomeRestoration.assertPendingOwner(ownership)
    assert()
    return SnapshotCheckpoint.withRestoredSegment({ directory, expected, source, keys, signal }, async (prepared) => {
      assertPrepared = prepared.assertCurrent
      const signal = prepared.signal
      let ancestor = artifacts
      while (
        !(await fs.lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        }))
      ) {
        assert()
        const parent = path.dirname(ancestor)
        if (parent === ancestor) fail("artifact anchor is unavailable")
        ancestor = parent
      }
      await directoryIdentity(ancestor)
      await directories(ancestor, artifacts, assert)
      const artifactIdentity = await directoryIdentity(artifacts)
      assert()
      return SnapshotLease.withHome(
        artifacts,
        async () => {
          assert()
          const temporary = await fs.mkdtemp(path.join(artifacts, ".snapshot-install-"))
          initializeSqliteEngine()
          const database = new Database(path.join(temporary, "index.sqlite"))
          try {
            database.exec(
              "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE formats(scope TEXT PRIMARY KEY,external INTEGER NOT NULL); CREATE TABLE owners(scope TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id)); CREATE TABLE roots(scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,canonical INTEGER NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE fences(scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE parts(scope TEXT NOT NULL,id TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,id,root)); CREATE TABLE repositories(destination TEXT PRIMARY KEY,stage TEXT NOT NULL,scope TEXT NOT NULL,layout TEXT NOT NULL,name TEXT NOT NULL,groupHash TEXT NOT NULL,identity TEXT,closureHash TEXT,configurationHash TEXT)",
            )
            using formatInsert = database.prepare("INSERT INTO formats VALUES (?,?)")
            using ownerInsert = database.prepare("INSERT INTO owners VALUES (?,?,?)")
            using rootInsert = database.prepare(
              "INSERT INTO roots VALUES (?,?,?,?) ON CONFLICT(scope,id,root) DO UPDATE SET canonical=MAX(canonical,excluded.canonical)",
            )
            using fenceInsert = database.prepare("INSERT INTO fences VALUES (?,?,?)")
            using partInsert = database.prepare("INSERT OR IGNORE INTO parts VALUES (?,?,?)")
            for await (const entry of StorageCheckpoint.entries({
              directory: namespaceDirectory,
              expected: source,
              keys,
              signal,
            })) {
              assert()
              if (entry.type !== "record") continue
              const key = entry.key
              const header = Content.headerIdentity(key)
              const fence = Content.fenceIdentity(key)
              if (key.length === 3 && key[0] === "snapshot-v2" && key[2] === "repository") {
                const value = SnapshotStore.RepositoryFormat.parse(entry.value)
                formatInsert.run(SnapshotStore.component(key[1]), Number(value.content === "external-v1"))
              } else if (key.length === 4 && key[0] === "snapshot-v2" && key[2] === "owners") {
                ownerInsert.run(
                  SnapshotStore.component(key[1]),
                  SnapshotStore.component(key[3]),
                  JSON.stringify(SnapshotStore.Owner.parse(upgradeImportedRecord(key, entry.value))),
                )
              } else if (header) {
                const value = header.legacy
                  ? Content.LegacyManifest.parse(entry.value)
                  : Content.Header.parse(entry.value)
                if (value.root !== header.root) fail("stored root differs from its owning key")
                rootInsert.run(header.scopeID, header.retentionID, header.root, Number(!header.legacy))
              } else if (fence) {
                Content.LegacyFence.parse(entry.value)
                fenceInsert.run(fence.scopeID, fence.retentionID, fence.root ?? "all")
              } else if (key.length === 7 && key[0] === "sessions" && key[3] === "messages" && key[5] === "parts")
                for (const root of SnapshotRecords.partRoots(entry.value)) partInsert.run(key[1], key[2], root)
            }
            assert()
            database.exec(
              "DELETE FROM roots WHERE canonical=0 AND EXISTS(SELECT 1 FROM fences f WHERE f.scope=roots.scope AND f.id=roots.id AND (f.root='all' OR f.root=roots.root))",
            )
            {
              using find = database.prepare<{ destination: string; stage: string; groupHash: string }, [string]>(
                "SELECT destination,stage,groupHash FROM repositories WHERE destination=?",
              )
              using mismatchedBackend = database.prepare("SELECT 1 FROM formats WHERE external<>? LIMIT 1")
              if (mismatchedBackend.get(Number(SnapshotStore.usesExternalStorage())))
                fail("target composition differs from the fixed namespace backend")
              using add = database.prepare("INSERT INTO repositories VALUES (?,?,?,?,?,?,NULL,NULL,NULL)")
              using update = database.prepare("UPDATE repositories SET groupHash=? WHERE destination=?")
              using external = database.prepare<{ external: number }, [string]>(
                "SELECT external FROM formats WHERE scope=?",
              )
              let ordinal = 0
              for await (const item of prepared.repositories()) {
                assert()
                const info = item.info
                if (
                  (info.layout === "stored") !== Boolean(external.get(info.scopeID)?.external) &&
                  info.layout !== "legacy"
                )
                  fail("repository layout differs from the fixed namespace backend")
                const destination = SnapshotStore.archivedRepository(info)
                let group = find.get(destination)
                if (!group) {
                  const stage = path.join(temporary, String(ordinal++), "store.git")
                  await SnapshotStore.initializeBareRepository(stage, "durable", { emptyTemplate: true })
                  add.run(destination, stage, info.scopeID, info.layout, info.name, digest(info))
                  group = find.get(destination)!
                  await AtomicFile.writeFileAtomic(path.join(stage, "HEAD"), info.head, {
                    private: true,
                    durable: true,
                  })
                } else {
                  if ((await nativeFile(path.join(group.stage, "HEAD"), 1024 * 1024, assert)) !== info.head)
                    fail("shared stored cache has inconsistent HEAD metadata")
                  update.run(digest([group.groupHash, info]), destination)
                }
                await using catalog = await SnapshotTransfer.Catalog.create(group.stage, signal)
                await catalog.import(item.repository, { signal, keepToken: "synergy-snapshot-restoration" })
                for await (const line of SnapshotGit.lines(
                  item.repository,
                  ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)"],
                  { signal },
                )) {
                  assert()
                  const [name, oid, symbolic] = line.split("\0")
                  const value = SnapshotSegment.Reference.parse({
                    version: 1,
                    name,
                    oid,
                    ...(symbolic ? { symbolic } : {}),
                  })
                  await SnapshotGit.checked(
                    group.stage,
                    value.symbolic
                      ? ["symbolic-ref", value.name, value.symbolic]
                      : ["update-ref", value.name, value.oid],
                    { signal },
                  )
                }
                assert()
              }
              using groups = database.prepare<
                {
                  destination: string
                  stage: string
                  groupHash: string
                  identity: string | null
                  closureHash: string | null
                  configurationHash: string | null
                },
                []
              >(
                "SELECT destination,stage,groupHash,identity,closureHash,configurationHash FROM repositories ORDER BY destination",
              )
              using recordIdentity = database.prepare("UPDATE repositories SET identity=? WHERE destination=?")
              using recordClosure = database.prepare(
                "UPDATE repositories SET closureHash=?,configurationHash=? WHERE destination=?",
              )
              const originalReference = (groupHash: string, closureHash: string) =>
                Reference.parse({
                  version: 1,
                  installationID: identity.installationID,
                  requestHash: identity.requestHash,
                  sourceHash: request.sourceHash,
                  segmentHash: manifestHash(expected),
                  groupHash,
                  closureHash,
                })
              const validateReference = async (repository: string, value: z.infer<typeof Reference>) => {
                const filename = reference(repository)
                const stat = await fs.lstat(filename).catch(() => undefined)
                if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 8192)
                  fail("publication reference is missing or invalid")
                if (digest(Reference.parse(JSON.parse(await nativeFile(filename, 8192, assert)))) !== digest(value))
                  fail("publication reference belongs to another installation")
                assert()
              }
              using ownerRows = database.prepare<{ scope: string; id: string; body: string }, []>(
                "SELECT scope,id,body FROM owners ORDER BY scope,id",
              )
              using roots = database.prepare<{ root: string }, [string, string]>(
                "SELECT root FROM roots WHERE scope=? AND id=? ORDER BY root",
              )
              using parts = database.prepare<{ root: string }, [string, string]>(
                "SELECT root FROM parts WHERE scope=? AND id=? ORDER BY root",
              )
              for (const row of ownerRows.iterate()) {
                const owner = SnapshotStore.Owner.parse(JSON.parse(row.body))
                if (owner.backend === "legacy" && owner.retentionID !== row.id)
                  fail("legacy retention cannot redirect its canonical owner")
                if (owner.backend === "deleted") continue
                const layout =
                  owner.backend === "legacy" ? "legacy" : external.get(row.scope)?.external ? "stored" : "native"
                const destination = SnapshotStore.archivedRepository({
                  scopeID: row.scope,
                  layout,
                  name: layout === "native" ? "store" : owner.retentionID,
                })
                const selected = find.get(destination)
                if (!selected) fail("segment omits a canonical Snapshot owner")
                for (const iterator of [roots.iterate(row.scope, owner.retentionID), parts.iterate(row.scope, row.id)])
                  for (const { root } of iterator) {
                    assert()
                    if ((await SnapshotGit.checked(selected.stage, ["cat-file", "-t", root], { signal })) !== "tree")
                      fail("segment omits canonical history")
                    if (
                      layout !== "legacy" &&
                      (await SnapshotGit.checked(
                        selected.stage,
                        ["rev-parse", "--verify", SnapshotStore.reference(owner.retentionID, root)],
                        { signal },
                      )) !== root
                    )
                      fail("retention reference omits canonical history")
                  }
              }
              using missing = database.prepare(
                "SELECT 1 FROM parts p LEFT JOIN owners o ON o.scope=p.scope AND o.id=p.id WHERE o.id IS NULL LIMIT 1",
              )
              if (missing.get()) fail("history has no canonical Snapshot owner")
              for (const group of groups.iterate()) {
                assert()
                const preparedClosure = await closure(group.stage, signal, assert)
                recordClosure.run(preparedClosure.hash, preparedClosure.configurationHash, group.destination)
                const value = originalReference(group.groupHash, preparedClosure.hash)
                await directories(artifacts, path.dirname(group.destination), assert)
                const previous = await fs.lstat(group.destination).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== "ENOENT") throw error
                })
                if (previous) {
                  await directoryIdentity(group.destination)
                  await validateReference(group.destination, value)
                  if (
                    (await closure(group.destination, signal, assert, preparedClosure.configurationHash)).hash !==
                    preparedClosure.hash
                  )
                    fail("repository differs from its fixed closure")
                } else {
                  await AtomicFile.writeJsonAtomic(reference(group.stage), JSON.stringify(value), {
                    private: true,
                    durable: true,
                  })
                  assert()
                  await fs.rename(group.stage, group.destination)
                }
                await synchronize(path.dirname(group.destination))
                recordIdentity.run(await directoryIdentity(group.destination), group.destination)
                assert()
              }
              const verify = async () => {
                assert()
                await HomeRestoration.verifyCurrent(permit)
                assert()
                if ((await directoryIdentity(artifacts)) !== artifactIdentity)
                  fail("artifact directory identity changed")
                for (const group of groups.iterate()) {
                  assert()
                  if ((await directoryIdentity(group.destination)) !== group.identity)
                    fail("installed repository identity changed")
                  if (!group.closureHash || !group.configurationHash) fail("fixed repository closure is unavailable")
                  await validateReference(group.destination, originalReference(group.groupHash, group.closureHash))
                  if (
                    (await closure(group.destination, signal, assert, group.configurationHash)).hash !==
                    group.closureHash
                  )
                    fail("repository differs from its fixed closure")
                }
                assert()
              }
              await verify()
              const evidence: Installed = Object.freeze({
                manifest: prepared.manifest,
                signal,
                assertCurrent: assert,
                verify,
              })
              installed.set(evidence, { assert, verify })
              const result = await body(evidence)
              await verify()
              return result
            }
          } finally {
            active = false
            database.close(true)
            await fs.rm(temporary, { recursive: true, force: true })
          }
        },
        { signal },
      )
    })
  }
}
