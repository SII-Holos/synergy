import { expect, spyOn, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { testResources } from "@ericsanchezok/synergy-testing/resources"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  SessionTransferEpochs as Epochs,
  SessionTransferSource as Source,
} from "@ericsanchezok/synergy-harness/session/transfer"
import { OrganizationRecord as Record } from "../../organization/src/storage/records"
import { OrganizationStoragePath as ServiceKeys } from "../../organization/src/storage/path"
import { OrganizationSharing as Sharing } from "../../organization/src/sharing"
import { OrganizationSharedHistory as SharedHistory } from "../../organization/src/shared-history"
import { prepareMemberHome } from "../src/home"
import { enrollMemberRuntime } from "../src/enrollment"
import { openMemberRuntime } from "../src/runtime"
import { Batch } from "../src/sync-outbox"
import { OrganizationSyncPath as Keys } from "../src/storage/path"
import { fixture } from "./support/organization"

async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 15000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error(label)
    await Bun.sleep(25)
  }
}
async function port() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const result = probe.port!
  await probe.stop(true)
  return result
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function paired(mode: "lost-ack" | "absent") {
  const resources = testResources()
  try {
    const service = await fixture({ connections: { heartbeatMs: 25 } })
    resources.defer("paired Service", () => service[Symbol.asyncDispose]())
    const options = { headers: service.headers, throwOnError: true as const }
    const coordinator = new WorkspaceCoordinator({ directory: path.join(service.root, "claims") })
    const online = new Set<string>()
    const peers = new Map<Parameters<NonNullable<Parameters<typeof service.interceptFrames>[0]>>[0], string>()
    const sendSpies: Array<{ mockRestore(): void }> = []
    const intercepted = new Set<unknown>()
    const submitted: Array<{ runtimeID: string; batch: Sync.Batch }> = []
    let sessionID = ""
    let blocked = mode === "absent"
    let sourceID = ""
    let lostAcknowledgements = 0
    service.interceptFrames((socket, raw) => {
      const frame = Runtime.ClientFrame.parse(JSON.parse(String(raw)))
      if (frame.type === "handshake") peers.set(socket, frame.proof.handshake.runtimeID)
      if (frame.type === "heartbeat") online.add(peers.get(socket) ?? "")
      if (frame.type !== "sync-batch" || frame.batch.sessionID !== sessionID) return false
      const runtimeID = peers.get(socket)
      if (!runtimeID) throw new Error("The actual submitted batch has no enrolled peer")
      submitted.push({ runtimeID, batch: frame.batch })
      if (runtimeID !== sourceID || frame.batch.bindingEpoch !== 1) return false
      if (mode === "lost-ack" && !intercepted.has(socket)) {
        intercepted.add(socket)
        const send = socket.send.bind(socket)
        sendSpies.push(
          spyOn(socket, "send").mockImplementation((data, compress) => {
            if (typeof data === "string") {
              const parsed = Runtime.ServerFrame.safeParse(JSON.parse(data))
              if (
                parsed.success &&
                parsed.data.type === "sync-ack" &&
                parsed.data.ack.sessionID === sessionID &&
                parsed.data.ack.bindingEpoch === 1
              ) {
                lostAcknowledgements++
                return 1
              }
            }
            return send(data, compress)
          }),
        )
      }
      return blocked
    })
    resources.defer("original batch transport fault", () => {
      blocked = false
      service.interceptFrames(undefined)
      for (const spy of sendSpies) spy.mockRestore()
    })
    async function member(deviceID: string) {
      const home = await prepareMemberHome({
        baseDirectory: path.join(service.root, "members"),
        identity: { ...service.identity, deviceID },
        origin: service.origin,
      })
      const registration = await enrollMemberRuntime({
        home: home.home,
        identity: home.identity,
        ca: service.ca,
        ticket: await service.ticket(deviceID, home.publicKey),
      })
      const listener = await port()
      const token = randomBytes(32).toString("hex")
      const runtime = await openMemberRuntime({
        home: home.home,
        identity: home.identity,
        ca: service.ca,
        handoff: true,
        listen: { port: listener, token },
        workspaceCoordinator: coordinator,
      })
      resources.defer(deviceID, () => runtime.close())
      await until(
        "The original enrolled participant did not heartbeat",
        async () => online.has(registration.runtimeID),
        Boolean,
      )
      return { runtime, registration }
    }
    const source = await member("sync-transfer-source")
    sourceID = source.registration.runtimeID
    const target = await member("sync-transfer-target")
    const project = (
      await service.client.orgProjects.create({ orgProjectCreate: { name: "Original batch handoff" } }, options)
    ).data
    sessionID = (
      await service.client.orgSessions.create(
        {
          orgCommandCreateRequest: {
            schemaVersion: 1,
            orgID: service.identity.orgID,
            projectID: project.projectID,
            runtimeID: sourceID,
            requestID: "create-original-sync",
            creation: { operation: "create", title: "Original immutable batch" },
          },
        },
        options,
      )
    ).data.effect.sessionID
    async function native<T>(member: typeof source, body: (session: Session.Info) => Promise<T>) {
      return member.runtime.run(async () => {
        const session = await Session.get(sessionID)
        return ScopeContext.provide({ scope: session.scope, workspace: session.workspace, fn: () => body(session) })
      })
    }
    const bytes = Uint8Array.from({ length: 4097 }, (_, index) => (index * 29) % 256)
    const original = await native(source, async (session) => {
      const message = MessageV2.User.parse({
        id: Identifier.ascending("message"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "general",
        model: { providerID: "fixture", modelID: "portable-original" },
      })
      await Session.updateMessage(message)
      const text = MessageV2.TextPart.parse({
        id: Identifier.ascending("part"),
        sessionID,
        messageID: message.id,
        type: "text",
        text: "A native Part removed after its immutable batch was sent",
      })
      await Session.updatePart(text)
      const owner = RolloutArtifact.Owner.parse({ kind: "session", scopeID: session.scope.id, sessionID })
      const artifact = await RolloutArtifact.write(
        owner,
        (async function* () {
          yield bytes
        })(),
        "application/octet-stream",
      )
      const attachment = MessageV2.AttachmentPart.parse({
        id: Identifier.ascending("part"),
        sessionID,
        messageID: message.id,
        type: "attachment",
        mime: "application/octet-stream",
        filename: "original.bin",
        url: "attachment://original",
        artifact,
      })
      await Session.updatePart(attachment)
      return { message, text, attachment, artifact, owner }
    })
    await service.client.orgSessions.share({ sessionID, orgShareChange: { expectedShareGeneration: 0 } }, options)
    const originalBatch = await until(
      "The original native batch was never submitted",
      () =>
        source.runtime.run(async () => {
          const [value] = await Storage.readMany([Keys.batch(service.identity.orgID, sessionID)])
          return value === undefined ? undefined : Batch.parse(value)
        }),
      (batch) => Boolean(batch && submitted.some((item) => item.batch.payloadHash === batch.payloadHash)),
    )
    if (!originalBatch) throw new Error("The actual pending batch disappeared before its original receipt")
    const identity = Sync.BatchIdentity.parse({
      sessionID,
      projectID: project.projectID,
      bindingEpoch: originalBatch.bindingEpoch,
      shareGeneration: originalBatch.shareGeneration,
      firstSeq: originalBatch.firstSeq,
      lastSeq: originalBatch.lastSeq,
      payloadHash: originalBatch.payloadHash,
    })
    const marker = () =>
      service.service.maintenance.run(() =>
        Record.read(
          Record.SharedBatch,
          ServiceKeys.sharedBatch(sessionID, identity.shareGeneration, identity.firstSeq),
        ),
      )
    if (mode === "lost-ack") {
      await until("The Service did not actually commit the batch before ACK loss", marker, Boolean)
      await until(
        "The original committed ACK was not lost",
        async () => lostAcknowledgements,
        (count) => count > 0,
      )
    } else expect(await marker()).toBeUndefined()
    await native(source, async () =>
      Session.removePart({ sessionID, messageID: original.message.id, partID: original.text.id }),
    )
    const preview = (
      await service.client.orgHandoff.options(
        { sessionID, targetRuntimeID: target.registration.runtimeID, requestID: "inspect-original-sync-handoff" },
        options,
      )
    ).data
    if (!preview.environment) throw new Error("The actual Native participants did not inspect their Environment")
    const handoffID = `portable-original-${mode}`
    const view = (
      await service.client.orgHandoff.prepare(
        {
          sessionID,
          orgHandoffPrepare: {
            handoffID,
            targetRuntimeID: target.registration.runtimeID,
            expectedBindingEpoch: preview.bindingEpoch,
            expectedControlRevision: preview.controlRevision,
            mappingPlanRevision: 1,
            workspaceMapping: { kind: "native" },
            environmentMapping: {
              version: 1,
              expectedSelectionRevision: preview.environment.expectedSelectionRevision,
              source: preview.environment.source,
              target: { kind: "none" },
            },
          },
        },
        options,
      )
    ).data
    await service.client.orgHandoff.accept(
      {
        handoffID,
        orgHandoffAccept: {
          mappingPlanRevision: view.mappingPlanRevision,
          mappingHash: view.mappingHash,
        },
      },
      options,
    )
    const binding = Epochs.Binding.parse({
      sessionID,
      scopeID: project.projectID,
      handoffID,
      sourceID,
      targetID: target.registration.runtimeID,
      fromEpoch: view.fromEpoch,
      toEpoch: view.toEpoch,
    })
    const raw = (operation: Handoff.Drive["operation"]) =>
      service.client.orgHandoff.drive(
        { handoffID, orgHandoffDrive: { operation, requestID: crypto.randomUUID() } },
        { headers: service.headers },
      )
    async function drive(operation: Handoff.Drive["operation"]) {
      const result = await raw(operation)
      if (result.response.ok) return Handoff.MachineResult.parse(result.data)
      if (
        z.object({ code: z.literal("COMMAND_OUTCOME_UNKNOWN"), outcome: z.literal("unknown") }).safeParse(result.error)
          .success
      ) {
        const inspect = operation.endsWith("-source") ? "inspect-source" : "inspect-target"
        const observed = await until(
          "The original Handoff invocation did not settle",
          async () => {
            const reply = await raw(inspect)
            if (!reply.response.ok) throw reply.error
            return Handoff.MachineResult.parse(reply.data)
          },
          (value) => value.state !== "working",
        )
        if (observed.state === "complete") return observed
      }
      throw result.error
    }
    return {
      service,
      source,
      target,
      native,
      options,
      sessionID,
      identity,
      originalBatch,
      original,
      bytes,
      binding,
      handoffID,
      submitted,
      marker,
      raw,
      drive,
      release() {
        blocked = false
      },
      [Symbol.asyncDispose]: resources.close,
    }
  } catch (error) {
    try {
      await resources.close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Native batch setup and original cleanup failed")
    }
    throw error
  }
}

type Frozen = Extract<Handoff.Proof, { purpose: "source-frozen" }>
async function activate(f: Awaited<ReturnType<typeof paired>>, frozen: Frozen) {
  if (!frozen.syncCheckpoint) throw new Error("The native Source has no captured sync checkpoint")
  const prepared = (await f.drive("prepare-target")).facts.find(
    (fact) => fact.proof.purpose === "target-prepared",
  )?.proof
  if (!prepared || prepared.purpose !== "target-prepared") throw new Error("The actual native Target did not prepare")
  expect(prepared.syncCheckpointHash).toBe(await Handoff.syncCheckpointHash(frozen.syncCheckpoint))
  await f.service.client.orgHandoff.permit(
    { handoffID: f.handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
    f.options,
  )
  expect((await f.drive("surrender-source")).facts[0]?.proof.purpose).toBe("source-surrendered")
  await f.service.client.orgHandoff.commit({ handoffID: f.handoffID, body: {} }, f.options)
  await f.service.client.orgHandoff.permit(
    { handoffID: f.handoffID, orgHandoffPermitRequest: { purpose: "handoff-activation" } },
    f.options,
  )
  expect((await f.drive("activate-target")).facts[0]?.proof.purpose).toBe("target-activated")
  await f.native(f.target, async (session) => {
    expect(session).toMatchObject({
      id: f.sessionID,
      paused: expect.anything(),
      organization: { driverRuntimeID: f.target.registration.runtimeID, bindingEpoch: 2 },
    })
    const parts = await MessageV2.parts({ sessionID: f.sessionID, messageID: f.original.message.id })
    const attachment = parts.find((part) => part.id === f.original.attachment.id)
    expect(attachment).toMatchObject({ type: "attachment", artifact: f.original.artifact })
    expect(parts.some((part) => part.id === f.original.text.id)).toBe(false)
    const loaded = Buffer.concat(await Array.fromAsync(RolloutArtifact.read(f.original.owner, f.original.artifact)))
    expect(hash(loaded)).toBe(hash(f.bytes))
    await Session.update(f.sessionID, (draft) => {
      draft.title = "Actual target epoch two"
    })
  })
  await until(
    "The real destination exporter did not settle its carried drafts",
    () =>
      f.target.runtime.run(async () => {
        const [batch] = await Storage.readMany([Keys.batch(f.service.identity.orgID, f.sessionID)])
        return {
          batch: Boolean(batch),
          drafts: await Storage.count({ prefix: Keys.drafts(f.service.identity.orgID, f.sessionID) }),
        }
      }),
    (value) => !value.batch && value.drafts === 0,
  )
  expect(
    f.submitted.filter((item) => item.runtimeID === f.target.registration.runtimeID && item.batch.bindingEpoch === 1),
  ).toEqual([])
  const events = (await f.service.client.orgSessionSync.events({ sessionID: f.sessionID, limit: 100 }, f.options)).data
  expect(
    events.items.some((event) => event.type === "part" && event.partID === f.original.text.id && event.removed),
  ).toBe(true)
  expect((await f.service.client.orgHandoff.get({ handoffID: f.handoffID }, f.options)).data.phase).toBe("completed")
}

test("a real sealed Source retries the same committed unknown batch and the native Target consumes its exact original receipt", async () => {
  await using f = await paired("lost-ack")
  const frozen = (await f.drive("prepare-source")).facts.find((fact) => fact.proof.purpose === "source-frozen")?.proof
  if (!frozen || frozen.purpose !== "source-frozen" || !frozen.syncCheckpoint)
    throw new Error("The actual Source did not seal its sync closure")
  expect(frozen.syncCheckpoint.pendingBatch).toEqual(f.identity)
  const sealed = await f.source.runtime.run(() => Source.status(f.binding))
  expect(sealed?.manifestHash).toBe(frozen.manifestHash)
  const recovered = (await f.drive("prepare-source")).facts.find(
    (fact) => fact.proof.purpose === "source-frozen",
  )?.proof
  expect(recovered).toEqual(frozen)
  expect(
    await f.source.runtime.run(
      async () => (await Storage.readMany([Keys.batch(f.service.identity.orgID, f.sessionID)]))[0],
    ),
  ).toBeUndefined()
  expect(await f.marker()).toMatchObject(f.identity)
  await activate(f, frozen)
}, 45000)

test("an absent original batch marker keeps the real Source frozen until same-intent settlement commits that immutable body", async () => {
  await using f = await paired("absent")
  await expect(f.drive("prepare-source")).rejects.toBeDefined()
  const sealed = await f.source.runtime.run(() => Source.status(f.binding))
  if (!sealed) throw new Error("The failed original batch settlement lost its actual sealed native package")
  expect(await f.marker()).toBeUndefined()
  const held = (await f.service.client.orgHandoff.get({ handoffID: f.handoffID }, f.options)).data
  expect(held).toMatchObject({ phase: "preparing", currentDriver: f.source.registration.runtimeID, bindingEpoch: 1 })
  expect((await f.raw("inspect-source")).data?.facts.some((fact) => fact.proof.purpose === "source-frozen")).toBe(false)
  const permit = await f.service.client.orgHandoff.permit(
    { handoffID: f.handoffID, orgHandoffPermitRequest: { purpose: "handoff-surrender" } },
    { headers: f.service.headers },
  )
  expect(permit.response.ok).toBe(false)
  expect(permit.error).toMatchObject({ code: "HANDOFF_BLOCKED" })
  expect(
    await f.source.runtime.run(async () =>
      Batch.parse((await Storage.readMany([Keys.batch(f.service.identity.orgID, f.sessionID)]))[0]),
    ),
  ).toEqual(f.originalBatch)
  f.release()
  const frozen = (await f.drive("prepare-source")).facts.find((fact) => fact.proof.purpose === "source-frozen")?.proof
  if (!frozen || frozen.purpose !== "source-frozen" || !frozen.syncCheckpoint)
    throw new Error("The original Source did not resume its finite settlement")
  expect(frozen.manifestHash).toBe(sealed.manifestHash)
  expect(frozen.syncCheckpoint.pendingBatch).toEqual(f.identity)
  expect(await f.marker()).toMatchObject(f.identity)
  const resent = f.submitted.filter(
    (item) => item.batch.firstSeq === f.identity.firstSeq && item.batch.bindingEpoch === 1,
  )
  expect(resent.length).toBeGreaterThanOrEqual(2)
  for (const item of resent) expect(item.batch.payloadHash).toBe(f.identity.payloadHash)
  await activate(f, frozen)
}, 45000)

test("a real completed shared handoff retains canonical history from both original binding epochs", async () => {
  await using f = await paired("lost-ack")
  const frozen = (await f.drive("prepare-source")).facts.find((fact) => fact.proof.purpose === "source-frozen")?.proof
  if (!frozen || frozen.purpose !== "source-frozen" || !frozen.syncCheckpoint)
    throw new Error("The actual Source did not capture its original sync closure")
  await activate(f, frozen)
  await until(
    "The actual rebound generation did not synchronize",
    async () => (await f.service.client.orgSessions.shareState({ sessionID: f.sessionID }, f.options)).data,
    (state) => state.bindingEpoch === 2 && state.syncState === "synced",
  )
  const rows = await f.service.service.maintenance.run(() =>
    Storage.snapshot(async (tx) => {
      const rows = new Map<string, unknown>()
      for await (const row of tx.exportEntries())
        if (row.type === "record") rows.set(JSON.stringify(row.key), row.value)
      return rows
    }),
  )
  const epochs = new Set<number>()
  for (const [key, value] of rows) {
    const address = z.array(z.string()).parse(JSON.parse(key))
    if (address[0] === "organization" && address[1] === "shared-batches" && address[2] === f.sessionID)
      epochs.add(Record.SharedBatch.parse(value).bindingEpoch)
  }
  expect([...epochs].sort()).toEqual([1, 2])
  const accepted = new Set<string>(),
    groups = new Map<string, string>()
  const reader: SharedHistory.Source = {
    read<T>(schema: z.ZodType<T>, key: string[]) {
      const value = rows.get(JSON.stringify(key))
      if (value === undefined) throw new Error("Missing actual Service history row")
      return schema.parse(structuredClone(value))
    },
    *entries(prefix) {
      for (const [key, value] of [...rows].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
        const address = z.array(z.string()).parse(JSON.parse(key))
        if (prefix.every((part, index) => address[index] === part))
          yield { key: address, value: structuredClone(value) }
      }
    },
    accept(key) {
      accepted.add(JSON.stringify(key))
    },
    first(key, value) {
      const id = JSON.stringify(key),
        current = JSON.stringify(value),
        previous = groups.get(id)
      if (previous !== undefined && previous !== current) throw new Error("Changed original historical group")
      if (previous !== undefined) return false
      groups.set(id, current)
      return true
    },
    binary(key, maximum) {
      return f.service.service.maintenance.run(() => Storage.readBinary(key, { maxBytes: maximum }))
    },
  }
  await Sharing.history(reader)
  expect(accepted.has(JSON.stringify(ServiceKeys.sharedState(f.sessionID)))).toBe(true)
  expect(
    accepted.has(JSON.stringify(ServiceKeys.sharedBatch(f.sessionID, f.identity.shareGeneration, f.identity.firstSeq))),
  ).toBe(true)
  expect(
    reader.read(
      Record.SharedBatch,
      ServiceKeys.sharedBatch(f.sessionID, f.identity.shareGeneration, f.identity.firstSeq),
    ).payloadHash,
  ).toBe(f.identity.payloadHash)
  async function rejectsChanged(key: string[], changed: unknown) {
    const id = JSON.stringify(key),
      original = rows.get(id)
    if (original === undefined) throw new Error("The corruption control has no actual original row")
    rows.set(id, changed)
    groups.clear()
    try {
      await expect(Sharing.history(reader)).rejects.toMatchObject({ data: { code: "PROTOCOL_MISMATCH" } })
    } finally {
      rows.set(id, original)
      groups.clear()
    }
  }
  const handoffKey = ["organization", "handoffs", f.handoffID]
  const originalHandoff = z.record(z.string(), z.unknown()).parse(rows.get(JSON.stringify(handoffKey)))
  await rejectsChanged(handoffKey, { ...originalHandoff, sourceRuntimeID: "off-chain-original-driver" })
  for (const field of ["surrenderPermit", "activationPermit"] as const) {
    const permit = Handoff.SignedPermit.parse(originalHandoff[field])
    await rejectsChanged(handoffKey, { ...originalHandoff, [field]: { ...permit, signature: "0".repeat(128) } })
  }
  const boundary = [
    ...reader.entries(["organization", "shared-batches", f.sessionID, String(f.identity.shareGeneration)]),
  ]
    .map((row) => ({ key: row.key, value: Record.SharedBatch.parse(row.value) }))
    .filter((row) => row.value.bindingEpoch === 2)
    .sort((left, right) => left.value.firstSeq - right.value.firstSeq)[0]
  if (!boundary) throw new Error("The real Handoff did not retain its epoch-two rebind marker")
  expect(boundary.value.firstSeq).toBe(boundary.value.lastSeq)
  await rejectsChanged(boundary.key, { ...boundary.value, lastSeq: boundary.value.lastSeq + 1 })
}, 45000)
