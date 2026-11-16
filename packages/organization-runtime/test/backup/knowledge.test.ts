import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { storageTestRuntime } from "@ericsanchezok/synergy-harness/test/support/storage-runtime"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationKnowledgeNative as Native } from "../../src/backup/knowledge"
import { prepareHostedHome, runtimeIdentityDigest, NativeHomeReaderContract } from "../../src/home"
import { enrollHostedRuntime } from "../../src/enrollment"
import { registerOrganizationNamespaceIdentity } from "../../src/namespace-identity"
import {
  stageKnowledgeSelection,
  activeKnowledge,
  knowledgeSkills,
  knowledgeFiles,
  type KnowledgeTransport,
} from "../../src/knowledge"
import { fixture } from "../support/organization"
import { ActiveKnowledgeStore as Active } from "../../src/knowledge-active"
import { OrganizationRecoveryArchive as Archive } from "../../../organization/src/backup/archive"
import { OrganizationBackupCohort as Cohort } from "../../../organization/src/backup/cohort"
import { OrganizationRuntimeNative as HomeNative } from "../../src/backup/native"
import { KnowledgeCache } from "../../src/knowledge-cache"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import type { StorageEntry } from "@ericsanchezok/synergy-harness/storage/portable"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const keys = {
  async current() {
    return { version: "recovery", key: Buffer.alloc(32, 8) }
  },
  async resolve() {
    return Buffer.alloc(32, 8)
  },
}
const actor = {
  kind: "system" as const,
  subjectID: "operator",
  displayName: "Operator",
  clientKind: "system" as const,
  requestID: "knowledge-native",
}
function transport(
  orgID: string,
  projectID: string,
  sessionID: string,
  version: number,
  count = 1,
): KnowledgeTransport {
  const files = Array.from({ length: count }, (_, i) => {
    const name = i === 0 ? "SKILL.md" : `references/${i}.txt`
    const content = Buffer.from(
      i === 0
        ? `---\nname: team-work\ndescription: Team work\n---\nVersion ${version}\n`
        : i === 1
          ? ""
          : `${projectID}:${version}:${i}`,
    )
    return {
      metadata: {
        fileID: hash(name),
        path: name,
        bytes: content.byteLength,
        sha256: hash(content),
        mediaType: "text/plain",
      },
      content,
    }
  }).sort((a, b) => a.metadata.fileID.localeCompare(b.metadata.fileID))
  const manifestHash = hash(files.map((f) => Publication.manifestLine(f.metadata)).join(""))
  const reference = { itemID: "team", version, manifestHash }
  const release = {
    ...reference,
    orgID,
    scope: { kind: "project" as const, projectID },
    kind: "skill" as const,
    title: "Team",
    authorID: "owner",
    publishedAt: 1,
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.content.byteLength, 0),
    skill: { name: "team-work", description: "Team work" },
  }
  return {
    async selection() {
      return {
        orgID,
        projectID,
        sessionID,
        selection: {
          revision: version,
          manifestHash: hash(JSON.stringify([reference])),
          releaseCount: 1,
          updatedBy: "owner",
          updatedAt: 1,
        },
        items: [release],
      }
    },
    async files(_reference, query) {
      const start = query?.cursor ? files.findIndex((f) => f.metadata.fileID === query.cursor) + 1 : 0
      const selected = files.slice(start, start + 100)
      return {
        items: selected.map((f) => f.metadata),
        ...(start + selected.length < files.length ? { cursor: selected.at(-1)!.metadata.fileID } : {}),
      }
    },
    async content(_reference, id, offset, length) {
      const file = files.find((f) => f.metadata.fileID === id)!
      return {
        fileID: id,
        offset,
        totalBytes: file.content.byteLength,
        sha256: file.metadata.sha256,
        data: file.content.subarray(offset, offset + length).toString("base64url"),
      }
    },
  }
}
async function source() {
  const service = await fixture()
  const home = await prepareHostedHome({
    baseDirectory: path.join(service.root, "hosted"),
    identity: { orgID: service.identity.orgID, hostID: "knowledge" },
    origin: service.origin,
  })
  const ticket = (
    await service.client.orgRuntime.registerHosted(
      { orgHostedRuntimeRegistration: { name: "Knowledge", publicKey: home.publicKey } },
      { headers: service.headers, throwOnError: true },
    )
  ).data
  await enrollHostedRuntime({ home: home.home, identity: home.identity, ticket, ca: service.ca })
  const runtime = await testRuntime({
    home: home.home,
    register() {
      HomeOwnership.select({
        owner: "organization-runtime",
        identity: runtimeIdentityDigest(home.identity),
        readerContract: NativeHomeReaderContract,
      })
      registerOrganizationNamespaceIdentity(home.identity)
      HomeNative.register({ identity: home.identity, ca: service.ca })
      RuntimeMaintenance.configure({ required: ["sessions", "loop-jobs", "environments"] })
    },
  })
  let lease: RuntimeMaintenance.Lease | undefined
  return {
    service,
    home,
    runtime,
    directory: path.join(service.root, "capture"),
    stage(projectID: string, sessionID: string, version: number, count = 1) {
      return runtime.run(() =>
        stageKnowledgeSelection({
          root: home.root,
          orgID: home.identity.orgID,
          projectID,
          sessionID,
          transport: transport(home.identity.orgID, projectID, sessionID, version, count),
        }),
      )
    },
    capture(before?: () => Promise<void>, signal?: AbortSignal) {
      return runtime.run(async () => {
        lease = await RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: actor.requestID, actor })
        const currentLease = lease
        await RuntimeMaintenance.freeze(currentLease, await RuntimeMaintenance.drain(currentLease))
        return RuntimeMaintenance.withFrozen(currentLease, () =>
          SnapshotMaintenance.withCapture(async (capture) => {
            const archive = await capture.exportArchive({
              directory: path.join(service.root, "capture", "records"),
              archiveID: "knowledge",
              namespaceID: "hosted",
              buildVersion: "fixture",
              keys,
              protect: () => true,
            })
            const evidence = await capture.validateArchive(archive)
            await before?.()
            const segment = await Native.capture({
              archive: evidence,
              lease: currentLease,
              directory: path.join(service.root, "capture", "knowledge"),
              keys,
              signal,
            })
            return { archive, segment, evidence, lease: currentLease }
          }),
        )
      })
    },
    async [Symbol.asyncDispose]() {
      if (lease) await runtime.run(() => RuntimeMaintenance.release(lease!))
      await runtime.close()
      await service[Symbol.asyncDispose]()
    },
  }
}

async function targetRuntime(home?: string) {
  const runtime = await storageTestRuntime({ home })
  const owner = await runtime.run(async () => {
    const context = RuntimeContext.current()
    const store = await TransactionalStore.open({
      backend: "sqlite",
      namespace: "restored",
      filename: path.join(context.host.root, "data", "restored.sqlite"),
    })
    context.storage = { store, artifactDirectory: path.join(context.host.root, "data", "artifacts") }
    RuntimeMaintenance.registerProtection()
    const lock = await ServerProcessLock.acquire()
    return { store, lock }
  })
  return {
    run: runtime.run,
    async [Symbol.asyncDispose]() {
      await owner.store.close()
      await owner.lock.release()
      await runtime.close()
    },
  }
}

async function rewriteSegment(
  input: { directory: string; namespace: StorageCheckpoint.Manifest },
  directory: string,
  change: (entry: StorageEntry) => StorageEntry | undefined,
) {
  const store = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "rewritten-knowledge",
    filename: path.join(directory, "work", "segment.sqlite"),
  })
  try {
    return await Storage.provide({ store, artifactDirectory: path.join(directory, "work", "artifacts") }, async () => {
      for await (const original of StorageCheckpoint.entries({
        directory: input.directory,
        expected: input.namespace,
        keys,
      })) {
        const entry = change(original)
        if (!entry) continue
        if (entry.type === "record") await Storage.write(entry.key, entry.value)
        else if (entry.type === "artifact") {
          using prepared = await Storage.prepareBinaryStream(
            entry.key,
            StorageCheckpoint.streamArtifact({ directory: input.directory, location: entry.location }),
          )
          await Storage.transaction(() => Storage.publishPreparedBinary(prepared))
        } else throw new Error("Unexpected fixture entry")
      }
      const output = path.join(directory, "archive")
      return {
        directory: output,
        namespace: await StorageCheckpoint.exportArchive({
          directory: output,
          archiveID: "rewritten-knowledge",
          namespaceID: input.namespace.namespaceID,
          buildVersion: input.namespace.buildVersion,
          keys,
          protect: () => true,
        }),
      }
    })
  } finally {
    await store.close()
  }
}

test("fixed Hosted knowledge references restore exact old and current Skill bytes with only owner-defined directory relocation", async () => {
  await using selected = await source()
  const retainedHeader = await selected.stage("one", "session", 1, 101)
  await selected.runtime.run(async () => {
    const cached = (await Storage.query({ prefix: ["organization-knowledge", "cache"], limit: 1 }))[0]
    if (!cached) throw new Error("Missing retained cache")
    for (let i = 0; i < 130; i++)
      await Active.put(
        { ...retainedHeader, sessionID: `retained-${String(i).padStart(3, "0")}` },
        0,
        Active.CachedRelease.parse(cached.value),
      )
  })
  await selected.stage("one", "session", 2)
  await selected.stage("two", "other", 1)
  const original = await selected.runtime.run(() => Storage.read(["organization-knowledge", "active", "session"]))
  const encrypted = path.join(selected.service.root, "encrypted")
  const opened = path.join(selected.service.root, "opened")
  const report = await Cohort.capture({
    service: Cohort.service(selected.service.service.maintenance),
    async resolve() {
      return Cohort.hosted(selected.runtime, { native: HomeNative.capture, knowledge: Native.capture })
    },
    directory: encrypted,
    archiveID: "knowledge-recovery",
    buildVersion: "fixture",
    keys,
    actor,
  })
  expect(report.namespaceCheckpointsComplete).toBe(true)
  await Archive.open({ directory: encrypted, outputDirectory: opened, keys })
  await fs.rm(encrypted, { recursive: true })
  const base = path.join(opened, "namespaces", "0000000000000001")
  const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
  expect(inventory.hostedNative).toBeDefined()
  expect(inventory.hostedKnowledge).toBeDefined()
  if (!inventory.hostedKnowledge) throw new Error("Missing knowledge segment")
  const captured = {
    archive: { namespace: inventory.namespace, directory: path.join(base, "records") },
    segment: { namespace: inventory.hostedKnowledge, directory: path.join(base, "hosted-knowledge") },
  }
  await fs.rm(path.join(selected.home.root, "data", "organization-knowledge"), { recursive: true })
  const foreignStore = await selected.runtime.run(() => Storage.current().store)
  await using target = await targetRuntime()
  let escaped: Native.Restored | undefined
  await target.run(() =>
    Native.withRestored(
      {
        directory: captured.segment.directory,
        expected: captured.segment.namespace,
        source: captured.archive.namespace,
        keys,
      },
      async (prepared) => {
        escaped = prepared
        await Storage.provide({ ...Storage.current(), store: foreignStore }, async () => {
          expect(() => prepared.assertCurrent()).toThrow("Store")
        })
        await StorageCheckpoint.restoreArchive({
          directory: captured.archive.directory,
          keys,
          restoreID: "knowledge-cold",
          async finalize(tx) {
            await prepared.relocate(tx)
            await tx.write(["recovery", "gate"], { paused: true })
          },
        })
        expect(await Storage.read(["organization-knowledge", "active", "session"])).toEqual(original)
        const current = await activeKnowledge("session")
        const other = await activeKnowledge("other")
        if (!current || !other) throw new Error("Missing restored knowledge headers")
        const first = await knowledgeSkills(current)
        const second = await knowledgeSkills(other)
        const firstBacking = first[0]?.info.backing
        const secondBacking = second[0]?.info.backing
        if (firstBacking?.kind !== "file" || secondBacking?.kind !== "file")
          throw new Error("Restored Skills require native files")
        expect(await Bun.file(firstBacking.entryFile).text()).toContain("Version 2")
        expect(await Bun.file(secondBacking.entryFile).text()).toContain("Version 1")
        expect(firstBacking.baseDir).not.toContain(selected.home.root)
        expect(firstBacking.baseDir).not.toBe(secondBacking.baseDir)
        expect(
          (await knowledgeFiles(current, { itemID: "team", version: 2, manifestHash: first[0]!.release.manifestHash }))
            .items,
        ).toHaveLength(1)
        expect(prepared.manifest.files).toBe(103)
        expect(prepared.manifest.addresses).toBeGreaterThan(128)
        const retained = (await Storage.query({ prefix: ["organization-knowledge", "cache"], limit: 100 }))
          .map((row) => Active.CachedRelease.parse(row.value))
          .find(
            (cached) =>
              cached.release.version === 1 &&
              cached.release.scope.kind === "project" &&
              cached.release.scope.projectID === "one",
          )
        if (!retained) throw new Error("The old sealed release was lost")
        expect(await Bun.file(path.join(retained.directory, "SKILL.md")).text()).toContain("Version 1")
        expect(await Bun.file(path.join(retained.directory, "references", "1.txt")).size).toBe(0)
        await expect(RuntimeMaintenance.assertAdmission()).rejects.toThrow()
      },
    ),
  )
  await target.run(async () => {
    const original = escaped
    if (!original) throw new Error("Missing restored owner")
    expect(() => original.assertCurrent()).toThrow("callback")
  })
}, 15000)

test("knowledge capture refuses changed immutable bytes instead of selecting a newer release", async () => {
  await using selected = await source()
  await selected.stage("one", "session", 1)
  const captured = await selected
    .capture(async () => {
      const file = await selected.runtime.run(() =>
        Storage.query({ prefix: ["organization-knowledge", "cache"], limit: 1 }),
      )
      const value = file[0]!.value as { release: unknown; directory: string }
      await Bun.write(path.join(value.directory, "SKILL.md"), "edited after the checkpoint")
    })
    .catch((error) => error)
  expect(captured).toBeInstanceOf(Error)
  expect(await fs.exists(path.join(selected.directory, "knowledge"))).toBe(false)
})

test("wrong source, missing bytes and an expired capture never enter native restoration or publish another segment", async () => {
  await using selected = await source()
  await selected.stage("one", "session", 1)
  const captured = await selected.capture()
  await selected.runtime.run(() =>
    expect(
      Native.capture({
        archive: captured.evidence,
        lease: captured.lease,
        directory: path.join(selected.service.root, "expired"),
        keys,
      }),
    ).rejects.toThrow("capture"),
  )
  await using target = await targetRuntime()
  await target.run(async () => {
    let entered = false
    await expect(
      Native.withRestored(
        {
          directory: captured.segment.directory,
          expected: captured.segment.namespace,
          source: { ...captured.archive.namespace, namespaceID: "wrong" },
          keys,
        },
        async () => {
          entered = true
        },
      ),
    ).rejects.toThrow("namespace")
    expect(entered).toBe(false)
    const objects = await fs.readdir(path.join(captured.segment.directory, "objects"))
    await fs.rm(path.join(captured.segment.directory, "objects", objects[0]!))
    await expect(
      Native.withRestored(
        {
          directory: captured.segment.directory,
          expected: captured.segment.namespace,
          source: captured.archive.namespace,
          keys,
        },
        async () => {
          entered = true
        },
      ),
    ).rejects.toThrow()
    expect(entered).toBe(false)
  })
})

test("cancelled native file capture preserves the original reason and leaves no complete segment", async () => {
  await using selected = await source()
  await selected.stage("one", "session", 1)
  const controller = new AbortController()
  const reason = new Error("knowledge capture cancelled")
  const open = fs.open.bind(fs)
  let intercepted = false
  const intercept = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (!String(args[0]).endsWith("/team-work/SKILL.md")) return file
    const read = file.read.bind(file)
    file.read = (async (...args: Parameters<typeof read>) => {
      const result = await read(...args)
      intercepted = true
      controller.abort(reason)
      return result
    }) as typeof file.read
    return file
  })
  try {
    await expect(selected.capture(undefined, controller.signal)).rejects.toBe(reason)
    expect(intercepted).toBe(true)
    expect(await fs.exists(path.join(selected.directory, "knowledge"))).toBe(false)
  } finally {
    intercept.mockRestore()
  }
})

test("a valid typed segment cannot use its wire Skill name to create target files outside the cache", async () => {
  await using selected = await source()
  await selected.stage("one", "session", 1)
  const captured = await selected.capture()
  const name = "../../../relocated-outside-cache"
  let release: Active.CachedRelease["release"] | undefined
  const changed = await selected.runtime.run(() =>
    rewriteSegment(captured.segment, path.join(selected.service.root, "malicious-name"), (entry) => {
      if (entry.type !== "record" || entry.key[0] !== "knowledge-native") return entry
      if (entry.key[1] === "cache") {
        const value = Active.CachedRelease.parse(entry.value)
        release = { ...value.release, skill: { ...value.release.skill!, name } }
        return { ...entry, value: { ...value, release } }
      }
      if (entry.key[1] === "address") {
        const value = entry.value as { value: Active.CachedRelease }
        return {
          ...entry,
          value: {
            ...value,
            value: {
              ...value.value,
              release: { ...value.value.release, skill: { ...value.value.release.skill!, name } },
            },
          },
        }
      }
      return entry
    }),
  )
  if (!release) throw new Error("Missing declared Skill")
  let ownerDenied = false
  try {
    KnowledgeCache.leaf(release)
  } catch {
    ownerDenied = true
  }
  const home = path.join(selected.service.root, "attack-owned", "one", "two", "three", "home")
  await using target = await targetRuntime(home)
  await target.run(async () => {
    const data = path.join(RuntimeContext.current().host.root, "data")
    const before = await fs.readdir(data)
    let entered = false
    const result = await Native.withRestored(
      { directory: changed.directory, expected: changed.namespace, source: captured.archive.namespace, keys },
      async () => {
        entered = true
      },
    ).then(
      () => undefined,
      (error) => error,
    )
    expect({ ownerDenied, restoreDenied: result instanceof Error, entered }).toEqual({
      ownerDenied: true,
      restoreDenied: true,
      entered: false,
    })
    expect(await fs.readdir(data)).toEqual(before)
  })
})

test("a pre-cancelled knowledge stream preserves its original reason before resolving a missing file", async () => {
  await using temporary = await tmpdir()
  const controller = new AbortController()
  const reason = new Error("original knowledge stream cancelled")
  controller.abort(reason)
  const reader = KnowledgeCache.stream(
    temporary.path,
    {
      fileID: hash("missing"),
      path: "missing",
      bytes: 0,
      sha256: hash(Buffer.alloc(0)),
      mediaType: "text/plain",
    },
    controller.signal,
  )
  await expect(reader.next()).rejects.toBe(reason)
})

test("an abort completed by fd.read is observed before the first cached file chunk is yielded", async () => {
  await using temporary = await tmpdir()
  const directory = await fs.realpath(temporary.path)
  const filename = path.join(directory, "payload.txt")
  const bytes = Buffer.from("nineteen-byte-value")
  await Bun.write(filename, bytes)
  const controller = new AbortController()
  const reason = new Error("fd read cancelled")
  const open = fs.open.bind(fs)
  const intercept = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (String(args[0]) !== filename) return file
    const read = file.read.bind(file)
    file.read = (async (...args: Parameters<typeof read>) => {
      const result = await read(...args)
      controller.abort(reason)
      return result
    }) as typeof file.read
    return file
  })
  const reader = KnowledgeCache.stream(
    directory,
    {
      fileID: hash("payload.txt"),
      path: "payload.txt",
      bytes: bytes.byteLength,
      sha256: hash(bytes),
      mediaType: "text/plain",
    },
    controller.signal,
  )
  try {
    await expect(reader.next()).rejects.toBe(reason)
  } finally {
    await reader.return(undefined)
    intercept.mockRestore()
  }
})

test("a valid segment omitting a complete cache partition cannot leave absolute source references after relocation", async () => {
  await using selected = await source()
  await selected.stage("one", "first", 1)
  await selected.stage("two", "second", 1)
  const captured = await selected.capture()
  const entries: StorageEntry[] = []
  for await (const entry of StorageCheckpoint.entries({
    directory: captured.segment.directory,
    expected: captured.segment.namespace,
    keys,
  }))
    entries.push(entry)
  const first = entries.find((entry) => entry.type === "record" && entry.key[1] === "cache")
  if (!first || first.type !== "record") throw new Error("Missing cache partition")
  const id = first.key[2]
  const removed = { addresses: 0, files: 0, bytes: 0 }
  for (const entry of entries) {
    if (entry.type !== "record") continue
    if (entry.key[1] === "address" && (entry.value as { cacheID: string }).cacheID === id) removed.addresses++
    if (entry.key[1] === "file" && entry.key[2] === id) {
      const file = Publication.File.parse(entry.value)
      removed.files++
      removed.bytes += file.bytes
    }
  }
  const changed = await selected.runtime.run(() =>
    rewriteSegment(captured.segment, path.join(selected.service.root, "omitted-partition"), (entry) => {
      if (entry.type !== "record" && entry.type !== "artifact") return entry
      if (["cache", "file", "bytes"].includes(entry.key[1]!) && entry.key[2] === id) return
      if (entry.type === "record" && entry.key[1] === "address" && (entry.value as { cacheID: string }).cacheID === id)
        return
      if (entry.type === "record" && entry.key[1] === "manifest") {
        const value = Native.Manifest.parse(entry.value)
        return {
          ...entry,
          value: {
            ...value,
            releases: value.releases - 1,
            addresses: value.addresses - removed.addresses,
            files: value.files - removed.files,
            bytes: value.bytes - removed.bytes,
          },
        }
      }
      return entry
    }),
  )
  await using target = await targetRuntime()
  await target.run(() =>
    Native.withRestored(
      { directory: changed.directory, expected: changed.namespace, source: captured.archive.namespace, keys },
      async (prepared) => {
        await expect(
          StorageCheckpoint.restoreArchive({
            directory: captured.archive.directory,
            keys,
            restoreID: "incomplete-cache",
            async finalize(tx) {
              await prepared.relocate(tx)
            },
          }),
        ).rejects.toThrow("coverage")
        expect(await Storage.query({ prefix: ["organization-knowledge"], limit: 1 })).toEqual([])
      },
    ),
  )
})

test("a foreign live write transaction cannot receive knowledge relocation from the prepared target", async () => {
  await using selected = await source()
  await selected.stage("one", "session", 1)
  const captured = await selected.capture()
  await using target = await targetRuntime()
  const foreign = await TransactionalStore.open({
    backend: "sqlite",
    namespace: "foreign-restored",
    filename: path.join(selected.service.root, "foreign-restored.sqlite"),
  })
  try {
    await target.run(async () => {
      await Storage.provide(
        { store: foreign, artifactDirectory: path.join(selected.service.root, "foreign-artifacts") },
        () =>
          StorageCheckpoint.restoreArchive({
            directory: captured.archive.directory,
            keys,
            restoreID: "foreign-copy",
            async finalize() {},
          }),
      )
      const before = await foreign.query({ prefix: ["organization-knowledge", "cache"], limit: 1 })
      await Native.withRestored(
        {
          directory: captured.segment.directory,
          expected: captured.segment.namespace,
          source: captured.archive.namespace,
          keys,
        },
        async (prepared) => {
          await expect(foreign.transaction((tx) => prepared.relocate(tx))).rejects.toThrow("write callback")
          expect(await foreign.query({ prefix: ["organization-knowledge", "cache"], limit: 1 })).toEqual(before)
        },
      )
    })
  } finally {
    await foreign.close()
  }
})
