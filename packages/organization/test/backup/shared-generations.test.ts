import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import {
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecoveryWriters as Writers } from "../../src/backup/writers"
import { OrganizationRecoveryAdministration as Recovery } from "../../src/backup/administration-recovery"
import { OrganizationCurrentAuthority as Current } from "../../src/backup/current-authority"
import { OrganizationRecoveryPublicationRecords as Publications } from "../../src/backup/publication-records"
import { OrganizationSharedGeneration as Generations } from "../../src/shared-generation"
import { OrganizationSharing as Sharing } from "../../src/sharing"
import { OrganizationSharedHistory } from "../../src/shared-history"
import { OrganizationSessionDirectory as Directory } from "../../src/session-directory"
import { OrganizationServiceHome } from "../../src/service-home"
import { OrganizationRecord as Record } from "../../src/storage/records"
import { OrganizationStoragePath as Keys } from "../../src/storage/path"
import { openOrganizationService, openOrganizationRecovery } from "../../src/service"
import { digest } from "../../src/auth/secret"
import { cookie } from "../../src/routes/shared"
import { preparedFixture } from "../support/recovery-administration"
import { fixture, password } from "../support/organization"
import { keys, register, proof, consume, connection } from "../support/runtime"

const sessionID = "legacy-original-archive-transcript"
type Rows = Map<string, unknown>
function history(rows: Rows): OrganizationSharedHistory.Source {
  const groups = new Map<string, string>()
  return {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      if (!rows.has(JSON.stringify(key))) throw new Error("Missing original historical owner row")
      return schema.parse(structuredClone(rows.get(JSON.stringify(key))))
    },
    *entries(prefix) {
      for (const [text, value] of [...rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const key = z.array(z.string()).parse(JSON.parse(text))
        if (prefix.every((part, index) => key[index] === part)) yield { key, value: structuredClone(value) }
      }
    },
    accept() {},
    first(key, value) {
      const text = JSON.stringify(key),
        current = digest(JSON.stringify(value)),
        previous = groups.get(text)
      if (previous && previous !== current) throw new Error("Changed original history group")
      if (previous) return false
      groups.set(text, current)
      return true
    },
    async binary() {
      throw new Error("This original safe transcript has no uploaded binary body")
    },
  }
}
async function archiveHash(directory: string) {
  const hash = createHash("sha256")
  const files: string[] = []
  async function visit(relative: string) {
    for (const file of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, file.name)
      if (file.isDirectory()) await visit(name)
      else if (file.isFile()) files.push(name)
      else throw new Error("The original archive contains another physical entry kind")
    }
  }
  await visit("")
  for (const name of files.sort()) {
    const body = createHash("sha256")
    for await (const bytes of Bun.file(path.join(directory, name)).stream()) body.update(bytes)
    hash.update(JSON.stringify([name, body.digest("hex")]) + "\n")
  }
  return hash.digest("hex")
}
async function producer(source: Awaited<ReturnType<typeof preparedFixture>>["source"]) {
  const owner = source.client()
  const login = await owner.login("owner", password)
  const token = login.headers
    .get("set-cookie")
    ?.split(";")[0]
    ?.slice(cookie.length + 1)
  if (!token) throw new Error("The actual authenticated owner did not receive its original cookie")
  const key = await keys()
  const ticket = await register(owner, "legacy-archive-device", key.publicKey)
  const enrolled = await consume(source, await proof(ticket, key.privateKey))
  expect(enrolled.status).toBe(200)
  const runtime = Runtime.Registration.parse(await enrolled.json())
  const projectResponse = await owner.request("POST", "/projects", { name: "Retained shared history" })
  expect(projectResponse.status).toBe(200)
  const project = z.object({ projectID: z.string() }).parse(await projectResponse.json())
  await source.service.maintenance.run(() =>
    Directory.reservePrivate({ token }, { sessionID, projectID: project.projectID, runtimeID: runtime.runtimeID }),
  )
  const shared = await owner.request("PUT", `/sessions/${sessionID}/share`, { expectedShareGeneration: 0 })
  expect(shared.status).toBe(200)
  const directory = await source.service.maintenance.run(() =>
    Record.read(Record.SessionDirectory, Keys.session(sessionID)),
  )
  if (!directory) throw new Error("The actual sharing owner lost its canonical Directory")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: source.service.fetch,
    websocket: source.service.websocket,
  })
  const socket = new WebSocket(new URL("/runtime/v1/connect", server.url).toString().replace(/^http/, "ws"))
  const queue: Runtime.ServerFrame[] = []
  const waiting: Array<ReturnType<typeof Promise.withResolvers<Runtime.ServerFrame>>> = []
  socket.onmessage = (event) => {
    const frame = Runtime.ServerFrame.parse(JSON.parse(String(event.data)))
    const next = waiting.shift()
    if (next) next.resolve(frame)
    else queue.push(frame)
  }
  socket.onclose = () => {
    for (const next of waiting.splice(0)) next.reject(new Error("The original producer closed"))
  }
  const next = () =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : (() => {
          const value = Promise.withResolvers<Runtime.ServerFrame>()
          waiting.push(value)
          return value.promise
        })()
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = reject
    })
    const handshake = await connection(runtime, key.privateKey, runtime.connectionEpoch + 1)
    handshake.proof.handshake.capabilities.push("sync")
    handshake.proof.handshake.schemas.sync = 1
    handshake.signature = await Runtime.sign(handshake.proof, key.privateKey)
    socket.send(JSON.stringify(handshake))
    Runtime.Connected.parse(await next())
    const events: Sync.Event[] = [
      {
        type: "session",
        sequence: 1,
        session: {
          sessionID,
          projectID: directory.projectID,
          creatorID: directory.creatorID,
          driverRuntimeID: directory.driverRuntimeID,
          bindingEpoch: directory.bindingEpoch,
          createdAt: directory.createdAt,
          shareGeneration: 1,
        },
      },
      {
        type: "message",
        sequence: 2,
        messageID: "shared-message",
        role: "assistant",
        createdAt: 1,
        summary: "original safe version",
        integrity: "a".repeat(64),
      },
      {
        type: "part",
        sequence: 3,
        messageID: "shared-message",
        partID: "shared-part",
        part: { type: "text", content: { kind: "inline", text: "retained original content" } },
        integrity: "b".repeat(64),
      },
    ]
    socket.send(
      JSON.stringify(
        Runtime.SyncBatch.parse({
          type: "sync-batch",
          connectionEpoch: handshake.proof.handshake.connectionEpoch,
          exchangeID: "original-archive-batch",
          batch: {
            schemaVersion: 1,
            sessionID,
            projectID: directory.projectID,
            bindingEpoch: directory.bindingEpoch,
            shareGeneration: 1,
            firstSeq: 1,
            lastSeq: 3,
            payloadHash: digest(JSON.stringify({ firstSeq: 1, lastSeq: 3, events })),
            events,
          },
        }),
      ),
    )
    const frame = await next()
    if (frame.type !== "sync-ack")
      throw new Error("The actual synchronization producer did not receive its original ACK")
    expect(frame.ack.nextSeq).toBe(4)
    const write = StoreTransaction.prototype.write
    let legacyFirstWrite = 0
    using previousWriter = spyOn(StoreTransaction.prototype, "write").mockImplementation(function (
      this: StoreTransaction,
      address,
      value,
      options,
    ) {
      if (
        Storage.current().transaction === this &&
        JSON.stringify(address) === JSON.stringify(Generations.key(sessionID, 1))
      ) {
        legacyFirstWrite++
        return Promise.resolve()
      }
      return write.call(this, address, value, options)
    })
    const revoked = await owner.request("DELETE", `/sessions/${sessionID}/share`, { expectedShareGeneration: 1 })
    expect(revoked.status).toBe(200)
    expect(legacyFirstWrite).toBe(1)
    await source.service.maintenance.run(async () => {
      expect((await Record.read(Record.SessionDirectory, Keys.session(sessionID)))?.shareState).toBe("private")
      expect((await Record.read(Record.SharedState, Keys.sharedState(sessionID)))?.shareGeneration).toBe(2)
      expect((await Storage.readMany([Generations.key(sessionID, 1)]))[0]).toBeUndefined()
    })
  } finally {
    socket.close()
    await server.stop(true)
  }
}
async function legacy(
  observe?: (source: Awaited<ReturnType<typeof preparedFixture>>["source"]) => Promise<void>,
  withTranscript = true,
) {
  const registerMigration = MigrationRegistry.register
  using catalog = spyOn(MigrationRegistry, "register").mockImplementation((domain, migrations, tracking) =>
    registerMigration(
      domain,
      migrations
        .filter(
          (migration) =>
            migration.id !== "20261116-organization-service-shared-generations-reader" &&
            migration.id !== "20261116-organization-shared-generation-registration",
        )
        .map((migration) => ({
          ...migration,
          dependsOn: migration.dependsOn?.filter(
            (id) => !id.endsWith("20261116-organization-shared-generation-registration"),
          ),
        })),
      tracking,
    ),
  )
  using selector = spyOn(OrganizationServiceHome, "selectForStartup").mockImplementation(async (options = {}) => {
    if (options.environments) throw new Error("The prior sharing catalog has no Environment owner")
    const { host } = RuntimeContext.current()
    const identity = digest("synergy.organization.service.v1")
    const actual = await HomeOwnershipFile.open({ root: host.root, env: host.env }).read()
    if (
      actual &&
      (actual.schemaVersion !== 2 ||
        actual.owner !== "organization" ||
        actual.identity !== identity ||
        actual.readerContract !== "native-organization-service-ownership-v1")
    )
      throw new Error("The prior selector cannot adopt another native owner")
    HomeOwnership.select({
      owner: "organization",
      identity,
      readerContract: "native-organization-service-ownership-v1",
    })
    return false
  })
  return await preparedFixture({
    beforeH0: withTranscript
      ? observe
        ? async (source) => {
            await producer(source)
            await observe(source)
          }
        : producer
      : observe,
  })
}

test("a fixed prior-writer archive recovers its retained shared generation through one current owner without rewriting that archive", async () => {
  await using f = await legacy()
  const originalArchive = await archiveHash(f.input.directory)
  const captured: Array<{ directory: string; before: string; after?: string }> = []
  const withCaptured = Current.withCaptured
  type Captured = Parameters<Parameters<typeof withCaptured>[1]>[0]
  using observations = spyOn(Current, "withCaptured").mockImplementation(
    async <T>(value: Current.Source, body: (selected: Captured) => Promise<T>) =>
      withCaptured(value, async (selected) => {
        const observation = {
          directory: selected.namespace.directory,
          before: await archiveHash(selected.namespace.directory),
          after: undefined as string | undefined,
        }
        captured.push(observation)
        try {
          return await body(selected)
        } finally {
          try {
            observation.after = await archiveHash(selected.namespace.directory)
          } catch {
            observation.after = undefined
          }
        }
      }),
  )
  const ready = await Recovery.recover(f.input)
  expect(ready.state).toBe("ready")
  expect(await archiveHash(f.input.directory)).toBe(originalArchive)
  expect(captured.length).toBeGreaterThan(0)
  for (const observed of captured) expect(observed.after).toBe(observed.before)
  const retry = await f.invoke()
  expect(retry.code, retry.stderr).toBe(0)
  expect(JSON.parse(retry.stdout)).toMatchObject({ state: "ready", installationID: f.target.installationID })
  expect(await archiveHash(f.input.directory)).toBe(originalArchive)
  await using current = await openOrganizationService({ home: f.input.home })
  const rows = await current.maintenance.run(() =>
    Storage.snapshot(async (tx) => {
      const rows: Rows = new Map()
      for await (const entry of tx.exportEntries())
        if (entry.type === "record") rows.set(JSON.stringify(entry.key), entry.value)
      return rows
    }),
  )
  expect(Record.SessionDirectory.parse(rows.get(JSON.stringify(Keys.session(sessionID))))).toMatchObject({
    shareState: "private",
    shareGeneration: 2,
  })
  const closed = Generations.Closed.parse(rows.get(JSON.stringify(Generations.key(sessionID, 1))))
  expect(closed.proof.kind).toBe("retained-inventory")
  if (closed.proof.kind !== "retained-inventory")
    throw new Error("The old archive was mislabeled as an original unshare")
  expect(closed.proof.retainedNextSeq).toBe(4)
  expect(closed.proof.origin).toMatchObject({
    kind: "archive-inventory",
    installationID: f.target.installationID,
    incarnation: f.target.incarnation,
  })
  await Sharing.history(history(rows))
  const omitted = new Map(rows)
  omitted.delete(JSON.stringify(Keys.sharedEvent(sessionID, 1, 3)))
  omitted.delete(JSON.stringify(Keys.sharedBatch(sessionID, 1, 1)))
  await expect(Sharing.history(history(omitted))).rejects.toThrow()
  const wrong = new Map(rows)
  if (closed.proof.origin.kind !== "archive-inventory")
    throw new Error("The original archive lost its retained provenance")
  wrong.set(JSON.stringify(Generations.key(sessionID, 1)), {
    ...closed,
    proof: { ...closed.proof, origin: { ...closed.proof.origin, namespaceHash: "0".repeat(64) } },
  })
  await expect(Sharing.history(history(wrong))).rejects.toThrow("original publication")
  await Sharing.history(history(rows))
}, 30_000)

test("a retained archive observation with another original namespace is rejected before its metadata or publication is installed", async () => {
  await using f = await legacy()
  const originalArchive = await archiveHash(f.input.directory)
  const archived = Generations.archived
  let observed = false
  using corruption = spyOn(Generations, "archived").mockImplementation((input) => {
    observed = true
    return archived({ ...input, origin: { ...input.origin, namespaceHash: "0".repeat(64) } })
  })
  const outcome = await Recovery.recover(f.input).then(
    () => ({ ready: true as const }),
    (error: unknown) => ({ ready: false as const, error }),
  )
  expect(observed).toBe(true)
  expect(outcome.ready).toBe(false)
  expect(await archiveHash(f.input.directory)).toBe(originalArchive)
  await using target = await openOrganizationRecovery({ home: f.input.home })
  await target.run(async () => {
    expect((await Storage.readMany([Generations.key(sessionID, 1)]))[0]).toBeUndefined()
    expect(
      (await Storage.readMany([["organization-recovery", "publication", f.target.installationID]]))[0],
    ).toBeUndefined()
  })
}, 30_000)

test("an actual prior sharing Home precheck observes retained inventory without publishing closure or format metadata", async () => {
  await using f = await legacy(async (source) => {
    await source.service.maintenance.run(async () => {
      const owner = await HomeOwnership.assert({ required: true })
      expect(owner).toMatchObject({
        schemaVersion: 2,
        owner: "organization",
        readerContract: "native-organization-service-ownership-v1",
      })
      const addresses = [
        Keys.session(sessionID),
        Keys.sharedState(sessionID),
        Generations.key(sessionID, 1),
        Generations.registrationKey,
      ]
      const before = await Storage.readMany(addresses)
      expect(before[2]).toBeUndefined()
      expect(before[3]).toBeUndefined()
      expect(await Writers.assertServiceOnly()).toEqual({ version: 1, externalWriters: 0 })
      expect(await Storage.readMany(addresses)).toEqual(before)
      expect(await HomeOwnership.assert({ required: true })).toEqual(owner)
    })
  })
  expect(f.target.installationID).toBeTruthy()
}, 30_000)

test("a current sharing Home cannot use retained-source inspection to hide a missing original closure", async () => {
  await using source = await fixture()
  await source.initialize()
  await producer(source)
  await source.service.maintenance.run(async () => {
    const owner = await HomeOwnership.assert({ required: true })
    expect(owner).toMatchObject({
      schemaVersion: 2,
      owner: "organization",
      readerContract: OrganizationServiceHome.readerContract,
    })
    const addresses = [
      Keys.session(sessionID),
      Keys.sharedState(sessionID),
      Generations.key(sessionID, 1),
      Generations.registrationKey,
    ]
    const before = await Storage.readMany(addresses)
    expect(before[2]).toBeUndefined()
    expect(before[3]).toEqual({ schemaVersion: 1 })
    const result = await Writers.assertServiceOnly().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.error).toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
    expect(await Storage.readMany(addresses)).toEqual(before)
    expect(await HomeOwnership.assert({ required: true })).toEqual(owner)
  })
}, 30_000)

test("retained archive metadata binds its complete Source owner to the actual publication", async () => {
  await using f = await legacy(undefined, false)
  await Recovery.recover(f.input)
  await using service = await openOrganizationService({ home: f.input.home })
  const publication = await service.maintenance.run(async () =>
    Publications.validate(await Storage.read(Publications.key(f.target.installationID)), f.target.installationID),
  )
  const sourceOwner = publication.source.owner
  expect(sourceOwner.schemaVersion).toBe(2)
  expect(OrganizationServiceHome.needsRetainedSharedGenerations(sourceOwner)).toBe(true)
  const session = Record.SessionDirectory.parse({
    schemaVersion: 2,
    orgID: publication.identity.orgID,
    sessionID: "retained-origin-owner-metadata",
    projectID: "retained-origin-metadata-project",
    creatorID: "retained-origin-metadata-owner",
    driverRuntimeID: "retained-origin-metadata-driver",
    bindingEpoch: 1,
    nextBindingEpoch: 2,
    createdAt: 0,
    shareState: "private",
    shareGeneration: 2,
    controlRevision: 0,
    rowRevision: 0,
    retainedExecutionGrants: 0,
    resourceIDs: [],
  })
  const origin = Generations.RetainedOrigin.parse({
    kind: "archive-inventory",
    installationID: publication.target.installationID,
    incarnation: publication.target.incarnation,
    namespaceHash: publication.source.current.namespaceHash,
    nativeHash: publication.source.current.nativeHash,
    sourceOwner,
  })
  if (origin.kind !== "archive-inventory") throw new Error("The actual publication has no archive metadata origin")
  const address = Generations.emptyKey(session.sessionID, 1)
  const range = Generations.EmptyRange.parse({
    version: 1,
    provenance: "retained-empty-inventory",
    origin,
    identity: {
      orgID: session.orgID,
      sessionID: session.sessionID,
      projectID: session.projectID,
      creatorID: session.creatorID,
      createdAt: session.createdAt,
    },
    firstGeneration: 1,
    lastGeneration: 1,
    observedAt: 0,
  })
  const rows: Rows = new Map()
  rows.set(JSON.stringify(Publications.key(publication.target.installationID)), publication)
  rows.set(JSON.stringify(Keys.session(session.sessionID)), session)
  rows.set(
    JSON.stringify(Keys.sharedState(session.sessionID)),
    Record.SharedState.parse({
      schemaVersion: 1,
      sessionID: session.sessionID,
      shareGeneration: 2,
      bindingEpoch: 1,
      nextSeq: 1,
      syncState: "blocked",
      updatedAt: 0,
    }),
  )
  rows.set(JSON.stringify(address), range)
  await OrganizationSharedHistory.transcripts(history(rows))
  const alternateReader =
    sourceOwner.readerContract === "native-organization-service-ownership-v1"
      ? "native-organization-service-environments-v1"
      : "native-organization-service-ownership-v1"
  for (const changed of [
    { ...sourceOwner, readerContract: alternateReader },
    { ...sourceOwner, identity: sourceOwner.identity === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) },
  ]) {
    const corrupted = new Map(rows)
    corrupted.set(
      JSON.stringify(address),
      Generations.EmptyRange.parse({
        ...range,
        origin: { ...origin, sourceOwner: changed },
      }),
    )
    const outcome = await OrganizationSharedHistory.transcripts(history(corrupted)).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )
    if (outcome.kind !== "rejected") throw new Error("Retained metadata accepted another original native Source owner")
    expect(outcome.error).toBeDefined()
  }
  await OrganizationSharedHistory.transcripts(history(rows))
  expect(await service.maintenance.run(() => Storage.read(Publications.key(f.target.installationID)))).toEqual(
    publication,
  )
}, 30_000)
