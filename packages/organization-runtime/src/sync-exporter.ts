import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { RuntimeIdentity } from "./home"
import type { MemberConnection } from "./connection"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { projectSharedPart } from "./transcript"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import { currentRunID, observeSessionStatus } from "./session-status"
import type { StatusInfo } from "@ericsanchezok/synergy-harness/session/types"
import { readCommandControlVersion } from "./command-intake"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"

const exporters = RuntimeContext.state(() => new Set<() => Promise<void>>())
export async function drainMemberSync(sessionID: string) {
  if (Storage.inTransaction() || !(await Epochs.isFrozen(sessionID)))
    throw new Error("Shared export drainage requires its frozen native source outside a transaction")
  await Promise.all([...exporters()].map((drain) => drain()))
}

const State = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  sessionID: Identity.ID,
  nextDraft: Identity.Revision,
  shareGeneration: Identity.Revision.optional(),
  projectionVersion: z.literal(2).optional(),
  syncState: Sync.SyncState,
  updatedAt: z.number().int().nonnegative(),
})
type State = z.infer<typeof State>

const Draft = z.strictObject({
  schemaVersion: z.literal(1),
  draftID: Identity.ID,
  sessionID: Identity.ID,
  localSequence: Identity.Revision,
  event: Sync.Event,
  queuedAt: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
type Draft = z.infer<typeof Draft>

const ProjectionRecord = z.strictObject({
  schemaVersion: z.literal(1),
  draftID: Identity.ID,
  localSequence: Identity.Revision,
  event: Sync.Event,
})
type ProjectionRecord = z.infer<typeof ProjectionRecord>

const AttachmentRecord = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  attachmentID: Identity.ID,
  scopeID: z.string().min(1),
  artifact: RolloutArtifact.Ref,
})
type AttachmentRecord = z.infer<typeof AttachmentRecord>

const BlobRecord = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  owner: RolloutArtifact.Owner,
  artifact: RolloutArtifact.Ref,
})
type BlobRecord = z.infer<typeof BlobRecord>

const Batch = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  bindingEpoch: Protocol.Epoch,
  shareGeneration: Identity.Revision,
  firstSeq: Sync.Sequence,
  lastSeq: Sync.Sequence,
  payloadHash: Protocol.Digest,
  draftIDs: z.array(Identity.ID).min(1).max(256),
  draftHashes: z.array(Protocol.Digest).min(1).max(256).optional(),
  events: z.array(Sync.Event).min(1).max(256),
})
type Batch = z.infer<typeof Batch>

const flushDelayMs = 40

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function safeSummary(value: string | undefined, limit = 32 * 1024) {
  return value?.slice(0, limit) ?? ""
}

function read<T>(schema: z.ZodType<T>, key: string[]) {
  return Storage.readMany<unknown>([key]).then(([value]) => (value === undefined ? undefined : schema.parse(value)))
}

function errorState(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 256) : "sync exporter failed"
}

export interface MemberSyncExporter {
  flush(): Promise<void>
  close(): Promise<void>
}

export function startMemberSyncExporter(input: {
  identity: RuntimeIdentity
  connection: Pick<MemberConnection, "connected" | "sync" | "syncState" | "uploadBlob">
  signal: AbortSignal
}): MemberSyncExporter {
  const { identity, connection, signal } = input
  const originalRuntime = RuntimeContext.current()
  const originalStore = Storage.current().store
  const originalConnection = connection.connected
  const connectionIdentity = JSON.stringify([
    originalConnection.orgID,
    originalConnection.deploymentIncarnation,
    originalConnection.runtimeID,
    originalConnection.connectionEpoch,
  ])
  const sessions = new Set<string>()
  const tails = new Map<string, Promise<void>>()
  const unsubs: Array<() => void> = []
  const pendingNative = new Map<string, Map<string, NativeChange>>()
  const nativeWorkers = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const retryTimer = setInterval(() => {
    if (sessions.size) schedule()
  }, 1_000)
  retryTimer.unref()
  let closed = false
  let running: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const drain = async () => {
    await Promise.allSettled([startup, ...tails.values(), ...(running ? [running] : [])])
  }
  const registeredExporters = exporters()
  registeredExporters.add(drain)

  function queue(sessionID: string, work: () => Promise<void>) {
    if (closed || signal.aborted) return
    const previous = tails.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await work()
      })
      .catch(() => {})
    tails.set(sessionID, next)
    void next.finally(() => {
      if (tails.get(sessionID) === next) tails.delete(sessionID)
    })
  }

  function schedule() {
    if (closed || signal.aborted || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, flushDelayMs)
    timer.unref()
  }

  function assertSource() {
    if (
      RuntimeContext.current() !== originalRuntime ||
      Storage.current().store !== originalStore ||
      connection.connected !== originalConnection ||
      connectionIdentity !==
        JSON.stringify([
          connection.connected.orgID,
          connection.connected.deploymentIncarnation,
          connection.connected.runtimeID,
          connection.connected.connectionEpoch,
        ])
    )
      throw new Error("Shared export lost its original Runtime, Store or connection")
  }

  async function sessionBinding(sessionID: string) {
    assertSource()
    const initial = await Session.get(sessionID).catch(() => undefined)
    if (!initial) return
    const chain: Session.Info[] = []
    const visited = new Set<string>()
    let current = initial
    while (true) {
      if (!visited.add(current.id)) return
      chain.push(current)
      if (!current.parentID) break
      if (!current.cortex || current.cortex.parentSessionID !== current.parentID) return
      const parent = await Session.get(current.parentID).catch(() => undefined)
      if (!parent) return
      current = parent
    }
    const root = chain.at(-1)!
    const binding = root.organization
    if (
      !binding ||
      binding.orgID !== identity.orgID ||
      binding.driverRuntimeID !== connection.connected.runtimeID ||
      binding.projectID !== root.scope.id ||
      chain.some(
        (entry) =>
          entry.organization?.orgID !== binding.orgID ||
          entry.organization?.projectID !== binding.projectID ||
          entry.organization?.creatorID !== binding.creatorID ||
          entry.organization?.driverRuntimeID !== binding.driverRuntimeID ||
          entry.organization?.bindingEpoch !== binding.bindingEpoch ||
          entry.scope.id !== binding.projectID,
      )
    )
      return
    if (await Epochs.isFrozen(root.id)) return
    return {
      session: initial,
      root,
      binding,
      rootSessionID: root.id,
      parentSessionID: initial.parentID,
    }
  }

  type Bound = NonNullable<Awaited<ReturnType<typeof sessionBinding>>>
  async function assertBinding(original: Bound) {
    const current = await sessionBinding(original.session.id)
    if (
      !current ||
      current.session.scope.id !== original.session.scope.id ||
      current.root.scope.id !== original.root.scope.id ||
      current.rootSessionID !== original.rootSessionID ||
      JSON.stringify(current.binding) !== JSON.stringify(original.binding)
    )
      throw new Error("Shared export lost its original native Session binding")
    return current
  }

  type DraftInput = { draftID: string; event: Sync.Event }

  function sameDraft(value: Draft | ProjectionRecord | undefined, rootSessionID: string, input: DraftInput) {
    return (
      value !== undefined &&
      value.draftID === input.draftID &&
      (!("sessionID" in value) ||
        (value.sessionID === rootSessionID && value.bytes === Buffer.byteLength(JSON.stringify(input.event)))) &&
      JSON.stringify(value.event) === JSON.stringify(input.event)
    )
  }

  async function putDrafts(rootSessionID: string, inputs: DraftInput[], original?: Bound) {
    if (!inputs.length) return
    const captured = original ?? (await sessionBinding(rootSessionID))
    if (!captured) return
    const bound = captured
    if (bound.rootSessionID !== rootSessionID) throw new Error("Shared events changed their original native root")
    for (let offset = 0; offset < inputs.length; offset += 128) {
      const window = inputs.slice(offset, offset + 128)
      await assertBinding(bound)
      const drafts = await Storage.readMany<unknown>(
        window.map((entry) => Keys.draft(identity.orgID, rootSessionID, entry.draftID)),
      )
      const projections = await Storage.readMany<unknown>(
        window.map((entry) => Keys.projection(identity.orgID, rootSessionID, entry.draftID)),
      )
      const changed = window.some(
        (entry, index) =>
          !sameDraft(
            drafts[index] === undefined
              ? projections[index] === undefined
                ? undefined
                : ProjectionRecord.parse(projections[index])
              : Draft.parse(drafts[index]),
            rootSessionID,
            entry,
          ),
      )
      if (!changed) {
        await assertBinding(bound)
        continue
      }
      await Storage.transaction(
        async () => {
          await assertBinding(bound)
          const current = await read(State, Keys.state(identity.orgID, rootSessionID))
          let nextDraft = current?.nextDraft ?? 1
          let written = false
          for (const input of window) {
            const draftKey = Keys.draft(identity.orgID, rootSessionID, input.draftID)
            const previous = await read(Draft, draftKey)
            const retained =
              previous ?? (await read(ProjectionRecord, Keys.projection(identity.orgID, rootSessionID, input.draftID)))
            if (sameDraft(retained, rootSessionID, input)) continue
            const localSequence = retained?.localSequence ?? nextDraft
            nextDraft = Math.max(nextDraft, localSequence + 1)
            const event = Sync.Event.parse({ ...input.event, sequence: 1 })
            await Storage.write(
              draftKey,
              Draft.parse({
                schemaVersion: 1,
                draftID: input.draftID,
                sessionID: rootSessionID,
                localSequence,
                event,
                queuedAt: previous?.queuedAt ?? Date.now(),
                bytes: Buffer.byteLength(JSON.stringify(event)),
              }),
            )
            await Storage.write(
              Keys.projection(identity.orgID, rootSessionID, input.draftID),
              ProjectionRecord.parse({
                schemaVersion: 1,
                draftID: input.draftID,
                localSequence,
                event,
              }),
            )
            await Storage.write(Keys.orderedDraft(identity.orgID, rootSessionID, localSequence), {
              draftID: input.draftID,
            })
            written = true
          }
          if (!written) return
          await Storage.write(
            Keys.state(identity.orgID, rootSessionID),
            State.parse({
              schemaVersion: 1,
              orgID: identity.orgID,
              sessionID: rootSessionID,
              nextDraft,
              shareGeneration: current?.shareGeneration,
              projectionVersion: current?.projectionVersion,
              syncState: current?.syncState === "failed" ? "pending" : (current?.syncState ?? "pending"),
              updatedAt: Date.now(),
            }),
          )
          await Storage.write(Keys.registeredRoot(identity.orgID, rootSessionID), { sessionID: rootSessionID })
        },
        { commitGuard: assertSource },
      )
    }
    sessions.add(rootSessionID)
    schedule()
  }

  async function putDraft(rootSessionID: string, draftID: string, event: Sync.Event) {
    await putDrafts(rootSessionID, [{ draftID, event }])
  }

  async function ensureSession(sessionID: string, observed?: StatusInfo) {
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    if (bound.parentSessionID) await ensureSession(bound.parentSessionID)
    if (bound.rootSessionID !== sessionID) await ensureSession(bound.rootSessionID)
    const { session, binding, rootSessionID, parentSessionID } = bound
    const draftID = digest({ type: "session", sessionID }).slice(0, 32)
    const previous = await read(ProjectionRecord, Keys.projection(identity.orgID, rootSessionID, draftID))
    let status = previous?.event.type === "session" ? previous.event.session.status : undefined
    const controlVersion = await readCommandControlVersion(identity.orgID, rootSessionID)
    if (
      !status ||
      observed ||
      status.controlVersion !== controlVersion ||
      status.runID !== (await currentRunID(session))
    )
      status = await observeSessionStatus(session, identity.orgID, rootSessionID)
    await putDraft(
      rootSessionID,
      draftID,
      Sync.Event.parse({
        type: "session",
        sequence: 1,
        session: {
          sessionID,
          projectID: binding.projectID,
          creatorID: binding.creatorID,
          driverRuntimeID: binding.driverRuntimeID,
          bindingEpoch: binding.bindingEpoch,
          createdAt: session.time.created,
          shareGeneration: 0,
          title: (await SecretMask.apply(session.title)).slice(0, 512),
          status,
          ...(rootSessionID === sessionID
            ? {}
            : {
                rootSessionID,
                parentSessionID,
                cortex: session.cortex && {
                  taskID: session.cortex.taskID,
                  parentSessionID: session.cortex.parentSessionID,
                  parentMessageID: session.cortex.parentMessageID,
                  status: session.cortex.status,
                  description: safeSummary(session.cortex.description, 512),
                  startedAt: session.cortex.startedAt,
                  completedAt: session.cortex.completedAt,
                  notifyParentOnComplete: session.cortex.notifyParentOnComplete,
                  visibility: session.cortex.visibility,
                },
              }),
        },
      }),
    )
  }

  async function rememberAttachment(sessionID: string, part: MessageV2.AttachmentPart) {
    const artifact = part.artifact
    if (!artifact) return
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    await Storage.write(
      Keys.attachment(identity.orgID, sessionID, part.id),
      AttachmentRecord.parse({
        schemaVersion: 1,
        sessionID,
        attachmentID: part.id,
        scopeID: bound.session.scope.id,
        artifact,
      }),
    )
  }

  async function rememberBlob(sessionID: string, owner: RolloutArtifact.Owner, artifact: RolloutArtifact.Ref) {
    if (artifact.status !== "complete" || !artifact.sha256) return
    await Storage.write(
      Keys.blob(identity.orgID, sessionID, artifact.id),
      BlobRecord.parse({ schemaVersion: 1, sessionID, owner, artifact }),
    )
  }

  function observeSession(sessionID: string) {
    queue(sessionID, async () => {
      const bound = await sessionBinding(sessionID)
      if (!bound) return
      await ensureSession(sessionID)
      if (!bound.session.cortex) return
      const cortex = bound.session.cortex
      const summary = safeSummary(cortex.error ?? (typeof cortex.output?.value === "string" ? cortex.output.value : ""))
      const safe = {
        sessionID,
        taskID: cortex.taskID,
        status: cortex.status,
        description: safeSummary(cortex.description, 512),
        completedAt: cortex.completedAt,
        summary,
        agent: safeSummary(cortex.agent, 256),
        model: cortex.model,
        category: cortex.category === undefined ? undefined : safeSummary(cortex.category, 512),
      }
      await putDraft(
        bound.rootSessionID,
        digest({ type: "cortex", sessionID, taskID: cortex.taskID }).slice(0, 32),
        Sync.Event.parse({
          type: "cortex",
          sequence: 1,
          sessionID,
          taskID: cortex.taskID,
          parentSessionID: cortex.parentSessionID,
          parentMessageID: cortex.parentMessageID,
          status: cortex.status,
          description: safeSummary(cortex.description, 512),
          startedAt: cortex.startedAt,
          completedAt: cortex.completedAt,
          notifyParentOnComplete: cortex.notifyParentOnComplete,
          deliveryNotifiedAt: cortex.deliveryNotifiedAt,
          summary,
          agent: safe.agent,
          model: safe.model,
          category: safe.category,
          integrity: digest(safe),
        }),
      )
    })
  }

  async function partDrafts(part: MessageV2.Part, bound: Bound): Promise<DraftInput[]> {
    const drafts: DraftInput[] = []
    const owner = { kind: "session", scopeID: bound.session.scope.id, sessionID: part.sessionID } as const
    const projected = await projectSharedPart(part, owner)
    if (!projected.part) return drafts
    for (const artifact of projected.blobs) {
      await rememberBlob(part.sessionID, owner, artifact)
      drafts.push({
        draftID: digest({ type: "blob", sessionID: part.sessionID, blobID: artifact.id }).slice(0, 32),
        event: Sync.Event.parse({
          type: "blob",
          sequence: 1,
          sessionID: part.sessionID,
          blobID: artifact.id,
          kind: "message-content",
          mediaType: artifact.mediaType,
          bytes: artifact.bytes,
          hash: artifact.sha256,
          state: "available",
        }),
      })
    }
    drafts.push({
      draftID: digest({ type: "part", sessionID: part.sessionID, partID: part.id }).slice(0, 32),
      event: Sync.Event.parse({
        type: "part",
        sequence: 1,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        part: projected.part,
        integrity: digest(projected.part),
      }),
    })
    return drafts
  }

  async function projectPart(part: MessageV2.Part) {
    const bound = await sessionBinding(part.sessionID)
    if (!bound) return
    await putDrafts(bound.rootSessionID, await partDrafts(part, bound), bound)
  }

  type NativeChange =
    | { kind: "message"; sessionID: string; messageID: string }
    | { kind: "part" | "part-removed"; sessionID: string; messageID: string; partID: string }

  function changeKey(change: NativeChange) {
    return change.kind === "message" ? `message:${change.messageID}` : `part:${change.messageID}:${change.partID}`
  }

  function observeNative(change: NativeChange) {
    if (closed || signal.aborted) return
    let pending = pendingNative.get(change.sessionID)
    if (!pending) {
      pending = new Map<string, NativeChange>()
      pendingNative.set(change.sessionID, pending)
    }
    pending.set(changeKey(change), change)
    startNativeWorker(change.sessionID)
  }

  function startNativeWorker(sessionID: string) {
    if (closed || signal.aborted || nativeWorkers.has(sessionID)) return
    nativeWorkers.add(sessionID)
    queue(sessionID, async () => {
      try {
        while (pendingNative.get(sessionID)?.size) {
          const pending = pendingNative.get(sessionID)!
          const window: Array<[string, NativeChange]> = []
          for (const entry of pending) {
            window.push(entry)
            if (window.length === 128) break
          }
          for (const [key] of window) pending.delete(key)
          try {
            const captured = await sessionBinding(sessionID)
            if (!captured) {
              if (!pending.size) pendingNative.delete(sessionID)
              continue
            }
            const bound = captured
            await ensureSession(sessionID)
            let drafts: DraftInput[] = []
            let bytes = 0
            async function publish() {
              if (!drafts.length) return
              await putDrafts(bound.rootSessionID, drafts, bound)
              drafts = []
              bytes = 0
            }
            for (const [, change] of window) {
              assertSource()
              let prepared: DraftInput[]
              if (change.kind === "message") {
                const info = await MessageV2.readInfo({
                  scopeID: bound.session.scope.id,
                  sessionID,
                  messageID: change.messageID,
                }).catch((error) => {
                  if (error instanceof Storage.NotFoundError) return
                  throw error
                })
                if (info && (info.id !== change.messageID || info.sessionID !== sessionID))
                  throw new Error("Shared native message does not match its original storage owner")
                prepared = info ? [await messageDraft(info, bound)] : []
              } else if (change.kind === "part-removed") {
                const removed = {
                  type: "part",
                  sequence: 1,
                  sessionID,
                  messageID: change.messageID,
                  partID: change.partID,
                  removed: true,
                }
                prepared = [
                  {
                    draftID: digest({ type: "part", sessionID, partID: change.partID }).slice(0, 32),
                    event: Sync.Event.parse({ ...removed, integrity: digest(removed) }),
                  },
                ]
              } else {
                const part = await MessageV2.readPart({
                  scopeID: bound.session.scope.id,
                  sessionID,
                  messageID: change.messageID,
                  partID: change.partID,
                })
                prepared = part ? await partDrafts(part, bound) : []
              }
              for (const draft of prepared) {
                const weight = Buffer.byteLength(JSON.stringify(draft.event))
                if (drafts.length && (drafts.length >= 128 || bytes + weight > 1024 * 1024)) await publish()
                drafts.push(draft)
                bytes += weight
              }
            }
            await publish()
          } catch (error) {
            for (const [key, change] of window) if (!pending.has(key)) pending.set(key, change)
            throw error
          }
          if (!pending.size) pendingNative.delete(sessionID)
        }
      } finally {
        nativeWorkers.delete(sessionID)
      }
    })
  }

  function observePart(part: MessageV2.Part) {
    observeNative({ kind: "part", sessionID: part.sessionID, messageID: part.messageID, partID: part.id })
  }

  function observeMessage(info: MessageV2.Info) {
    observeNative({ kind: "message", sessionID: info.sessionID, messageID: info.id })
  }

  async function messageDraft(info: MessageV2.Info, bound: Bound): Promise<DraftInput> {
    const summary =
      info.role === "user"
        ? safeSummary(info.summary?.body ?? info.summary?.title)
        : safeSummary(info.error?.name ?? info.finish)
    const safe = { messageID: info.id, role: info.role, createdAt: info.time.created, summary }
    return {
      draftID: digest({ type: "message", sessionID: info.sessionID, messageID: info.id }).slice(0, 32),
      event: Sync.Event.parse({
        type: "message",
        sequence: 1,
        ...(info.sessionID === bound.rootSessionID ? {} : { sessionID: info.sessionID }),
        messageID: info.id,
        role: info.role,
        createdAt: info.time.created,
        summary,
        actor: info.actor,
        agent: info.agent,
        rootID: info.rootID,
        model: info.role === "user" ? info.model : { providerID: info.providerID, modelID: info.modelID },
        ...(info.role === "assistant"
          ? {
              mode: info.mode,
              cost: info.cost,
              tokens: info.tokens,
              error: info.error && {
                code: info.error.name,
                message: (
                  await SecretMask.apply(
                    "message" in info.error.data && typeof info.error.data.message === "string"
                      ? info.error.data.message
                      : info.error.name,
                  )
                ).slice(0, 32 * 1024),
              },
            }
          : {}),
        ...(info.role === "assistant"
          ? { parentID: info.parentID, completedAt: info.time.completed, finish: info.finish }
          : {}),
        integrity: digest(safe),
      }),
    }
  }

  async function projectMessage(info: MessageV2.Info) {
    const bound = await sessionBinding(info.sessionID)
    if (!bound) return
    await putDrafts(bound.rootSessionID, [await messageDraft(info, bound)], bound)
  }

  function observeTool(event: { sessionID: string; record: RolloutEvents.Record }) {
    if (event.record.kind !== "tool" || event.record.value.owner.kind !== "session") return
    const tool = event.record.value
    const status =
      tool.status === "completed"
        ? "completed"
        : tool.status === "failed"
          ? "error"
          : tool.status === "cancelled" || tool.status === "interrupted"
            ? "unknown"
            : "running"
    queue(event.sessionID, async () => {
      const bound = await sessionBinding(event.sessionID)
      if (!bound) return
      await ensureSession(event.sessionID)
      const safe = { callID: tool.toolCallID, name: tool.tool, state: status }
      await putDraft(
        bound.rootSessionID,
        digest({ type: "tool", sessionID: event.sessionID, callID: tool.toolCallID }).slice(0, 32),
        Sync.Event.parse({
          type: "tool",
          sequence: 1,
          ...(event.sessionID === bound.rootSessionID ? {} : { sessionID: event.sessionID }),
          callID: tool.toolCallID,
          name: tool.tool,
          state: status,
          summary: "",
          integrity: digest(safe),
        }),
      )
      const owner = tool.owner
      const outputs = [["tool-output", tool.rawResult] as const, ["tool-observation", tool.observation] as const]
      for (const [kind, artifact] of outputs) {
        if (!artifact?.sha256 || artifact.status !== "complete") continue
        await rememberBlob(event.sessionID, owner, artifact)
        await putDraft(
          bound.rootSessionID,
          digest({ type: "blob", sessionID: event.sessionID, blobID: artifact.id, kind }).slice(0, 32),
          Sync.Event.parse({
            type: "blob",
            sequence: 1,
            ...(event.sessionID === bound.rootSessionID ? {} : { sessionID: event.sessionID }),
            blobID: artifact.id,
            kind,
            mediaType: artifact.mediaType.slice(0, 256) || "application/octet-stream",
            bytes: artifact.bytes,
            hash: artifact.sha256,
            state: "available",
          }),
        )
      }
    })
  }

  function observeAttachment(part: MessageV2.AttachmentPart) {
    const artifact = part.artifact
    if (!artifact?.sha256 || !Protocol.Digest.safeParse(artifact.sha256).success) return
    const filename = (part.filename ?? "attachment").split(/[\\/]/).at(-1) || "attachment"
    const attachment = Sync.Event.parse({
      type: "attachment",
      sequence: 1,
      sessionID: part.sessionID,
      attachmentID: part.id,
      filename: filename.slice(0, 512),
      mediaType: part.mime.slice(0, 256) || "application/octet-stream",
      bytes: artifact.bytes,
      hash: artifact.sha256,
      state: artifact.status === "complete" ? "available" : "uploading",
    })
    queue(part.sessionID, async () => {
      const bound = await sessionBinding(part.sessionID)
      if (!bound) return
      await ensureSession(part.sessionID)
      await rememberAttachment(part.sessionID, part)
      await putDraft(
        bound.rootSessionID,
        digest({ type: "attachment", sessionID: part.sessionID, attachmentID: part.id }).slice(0, 32),
        attachment,
      )
    })
  }

  async function observeNotification(sessionID: string, items: SessionInbox.Item[]) {
    queue(sessionID, async () => {
      const bound = await sessionBinding(sessionID)
      if (!bound) return
      for (const item of items) {
        const taskID = item.deliveryKey?.startsWith("cortex:taskNotification:")
          ? item.deliveryKey.slice("cortex:taskNotification:".length)
          : undefined
        if (!taskID) continue
        const children = await Session.children(sessionID).catch(() => [])
        const child = children.find((candidate) => candidate.cortex?.taskID === taskID)
        if (!child?.cortex) continue
        await tails.get(child.id)
        const summary = safeSummary(item.summary.preview ?? item.summary.title)
        const safe = { notificationID: item.id, taskID, childSessionID: child.id, status: child.cortex.status, summary }
        await putDraft(
          bound.rootSessionID,
          digest({ type: "notification", sessionID, notificationID: item.id }).slice(0, 32),
          Sync.Event.parse({
            type: "notification",
            sequence: 1,
            sessionID,
            notificationID: item.id,
            kind: "cortex-completion",
            taskID,
            childSessionID: child.id,
            status: child.cortex.status,
            createdAt: item.time.created,
            summary,
            integrity: digest(safe),
          }),
        )
      }
    })
  }

  async function uploadBatchBlobs(rootSessionID: string, share: Sync.Share, batch: Sync.Batch) {
    const events = batch.events.filter(
      (event): event is Extract<Sync.Event, { type: "attachment" | "blob" }> =>
        (event.type === "attachment" || event.type === "blob") && event.state === "available",
    )
    const uploaded = new Set<string>()
    for (const event of events) {
      const sourceSessionID = event.sessionID ?? rootSessionID
      const blobID = event.type === "attachment" ? event.attachmentID : event.blobID
      if (uploaded.has(blobID)) continue
      uploaded.add(blobID)
      const record =
        event.type === "attachment"
          ? await read(AttachmentRecord, Keys.attachment(identity.orgID, sourceSessionID, event.attachmentID))
          : await read(BlobRecord, Keys.blob(identity.orgID, sourceSessionID, event.blobID))
      if (!record || record.artifact.status !== "complete" || !record.artifact.sha256) continue
      const artifact = record.artifact
      const hashValue = artifact.sha256
      if (!hashValue || artifact.bytes !== event.bytes || hashValue !== event.hash)
        throw new Error("Attachment metadata changed")
      const hash = Protocol.Digest.parse(hashValue)
      const artifactOwner =
        "scopeID" in record
          ? ({ kind: "session", scopeID: record.scopeID, sessionID: sourceSessionID } as const)
          : record.owner
      if (artifact.bytes === 0) {
        if (!(await sessionBinding(rootSessionID))) return
        await connection.uploadBlob(
          {
            sessionID: rootSessionID,
            shareGeneration: share.shareGeneration,
            hash,
            offset: 0,
            totalBytes: 0,
            bytes: new Uint8Array(),
          },
          signal,
        )
        continue
      }
      const parts: Uint8Array[] = []
      let buffered = 0
      let offset = 0
      async function send() {
        if (!buffered) return
        if (!(await sessionBinding(rootSessionID))) throw new Error("Shared export source epoch is frozen")
        const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)))
        await connection.uploadBlob(
          {
            sessionID: rootSessionID,
            shareGeneration: share.shareGeneration,
            hash,
            offset,
            totalBytes: artifact.bytes,
            bytes,
          },
          signal,
        )
        offset += bytes.byteLength
        parts.length = 0
        buffered = 0
      }
      for await (const part of RolloutArtifact.read(artifactOwner, artifact)) {
        parts.push(part)
        buffered += part.byteLength
        if (buffered === 4 * 1024 * 1024) await send()
      }
      await send()
    }
  }

  async function prepareGeneration(rootSessionID: string, share: Sync.Share) {
    const current = await read(State, Keys.state(identity.orgID, rootSessionID))
    if (current?.shareGeneration === share.shareGeneration && current.projectionVersion === 2) return
    const captured = await sessionBinding(rootSessionID)
    if (!captured) return
    const bound = captured
    if (bound.binding.bindingEpoch !== share.bindingEpoch)
      throw new Error("Shared export generation changed its original native binding epoch")
    const pending = [rootSessionID]
    const visited = new Set<string>()
    while (pending.length) {
      if (closed || signal.aborted) return
      signal.throwIfAborted()
      const sessionID = pending.shift()!
      if (!visited.add(sessionID) || !(await sessionBinding(sessionID))) continue
      await ensureSession(sessionID)
      for await (const message of MessageV2.stream({ sessionID })) {
        if (closed || signal.aborted) return
        queue(sessionID, () => projectMessage(message.info))
        await tails.get(sessionID)
        for (const part of message.parts) {
          await projectPart(part)
          if (part.type === "attachment") observeAttachment(part)
          if (part.type === "tool" && part.state.status === "completed")
            for (const attachment of part.state.attachments ?? []) observeAttachment(attachment)
        }
        await tails.get(sessionID)
      }
      observeSession(sessionID)
      await tails.get(sessionID)
      pending.push(...(await Session.children(sessionID)).map((child) => child.id))
    }
    async function requeueProjections(keys: string[][]) {
      await assertBinding(bound)
      const values = await Storage.readMany<unknown>(keys)
      const projections = values.flatMap((value, index) => {
        if (value === undefined) return []
        const projection = ProjectionRecord.parse(value)
        if (
          JSON.stringify(keys[index]) !==
          JSON.stringify(Keys.projection(identity.orgID, rootSessionID, projection.draftID))
        )
          throw new Error("Shared projection belongs to another native draft")
        return [projection]
      })
      const drafts = await Storage.readMany<unknown>(
        projections.map((projection) => Keys.draft(identity.orgID, rootSessionID, projection.draftID)),
      )
      const orders = await Storage.readMany<unknown>(
        projections.map((projection, index) =>
          Keys.orderedDraft(
            identity.orgID,
            rootSessionID,
            drafts[index] === undefined ? projection.localSequence : Draft.parse(drafts[index]).localSequence,
          ),
        ),
      )
      const changed = projections.filter((projection, index) => {
        const previous = drafts[index] === undefined ? undefined : Draft.parse(drafts[index])
        const order =
          orders[index] === undefined ? undefined : z.strictObject({ draftID: Identity.ID }).parse(orders[index])
        return (
          !previous ||
          previous.draftID !== projection.draftID ||
          previous.sessionID !== rootSessionID ||
          previous.bytes !== Buffer.byteLength(JSON.stringify(projection.event)) ||
          JSON.stringify(previous.event) !== JSON.stringify(projection.event) ||
          order?.draftID !== projection.draftID
        )
      })
      await assertBinding(bound)
      if (!changed.length) return
      await Storage.transaction(
        async () => {
          await assertBinding(bound)
          for (const captured of changed) {
            const projection = await read(
              ProjectionRecord,
              Keys.projection(identity.orgID, rootSessionID, captured.draftID),
            )
            if (!projection) continue
            const draftKey = Keys.draft(identity.orgID, rootSessionID, projection.draftID)
            const previous = await read(Draft, draftKey)
            const localSequence = previous?.localSequence ?? projection.localSequence
            const event = Sync.Event.parse({ ...projection.event, sequence: 1 })
            await Storage.write(
              draftKey,
              Draft.parse({
                schemaVersion: 1,
                draftID: projection.draftID,
                sessionID: rootSessionID,
                localSequence,
                event,
                queuedAt: previous?.queuedAt ?? Date.now(),
                bytes: Buffer.byteLength(JSON.stringify(event)),
              }),
            )
            await Storage.write(Keys.orderedDraft(identity.orgID, rootSessionID, localSequence), {
              draftID: projection.draftID,
            })
          }
        },
        {
          commitGuard: () => {
            assertSource()
          },
        },
      )
    }
    let window: string[][] = []
    for await (const row of Storage.records<unknown>({
      prefix: Keys.projections(identity.orgID, rootSessionID),
      limit: 128,
    })) {
      if (closed || signal.aborted) return
      window.push(row.key)
      if (window.length < 128) continue
      await requeueProjections(window)
      window = []
    }
    if (window.length) await requeueProjections(window)
    await Storage.transaction(
      async () => {
        await assertBinding(bound)
        const latest = await read(State, Keys.state(identity.orgID, rootSessionID))
        await Storage.write(
          Keys.state(identity.orgID, rootSessionID),
          State.parse({
            schemaVersion: 1,
            orgID: identity.orgID,
            sessionID: rootSessionID,
            nextDraft: latest?.nextDraft ?? 1,
            shareGeneration: share.shareGeneration,
            syncState: "pending",
            projectionVersion: 2,
            updatedAt: Date.now(),
          }),
        )
      },
      {
        commitGuard: () => {
          assertSource()
        },
      },
    )
    sessions.add(rootSessionID)
    schedule()
  }

  async function prepare(sessionID: string, share: Sync.Share) {
    const batchKey = Keys.batch(identity.orgID, sessionID)
    const stored = await read(Batch, batchKey)
    if (stored && stored.shareGeneration === share.shareGeneration && stored.bindingEpoch === share.bindingEpoch) {
      const bound = await sessionBinding(sessionID)
      if (!bound) return
      return Sync.Batch.parse({
        schemaVersion: 1,
        sessionID: stored.sessionID,
        projectID: bound.binding.projectID,
        bindingEpoch: stored.bindingEpoch,
        shareGeneration: stored.shareGeneration,
        firstSeq: stored.firstSeq,
        lastSeq: stored.lastSeq,
        payloadHash: stored.payloadHash,
        events: stored.events,
      })
    }
    if (stored) await Storage.remove(batchKey)
    const rows = await Storage.query({ prefix: Keys.orderedDrafts(identity.orgID, sessionID), limit: 256 })
    const candidates = await Promise.all(
      rows.map(async (row) => {
        const index = z.strictObject({ draftID: Identity.ID }).parse(row.value)
        const draft = await read(Draft, Keys.draft(identity.orgID, sessionID, index.draftID))
        if (!draft) throw new Error("Pending sync order has no matching draft")
        return draft
      }),
    )
    const drafts: Draft[] = []
    let bytes = 1024
    for (const candidate of candidates) {
      if (drafts.length && bytes + candidate.bytes + 128 > 1024 * 1024) break
      drafts.push(candidate)
      bytes += candidate.bytes + 128
    }
    if (!drafts.length) return
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    const events = drafts.map((draft, index) => {
      const event = { ...draft.event, sequence: share.nextSeq + index }
      if (event.type === "session") event.session = { ...event.session, shareGeneration: share.shareGeneration }
      return Sync.Event.parse(event)
    })
    const firstSeq = events[0]!.sequence
    const lastSeq = events.at(-1)!.sequence
    const hash = digest({ firstSeq, lastSeq, events })
    const persisted = Batch.parse({
      schemaVersion: 1,
      sessionID,
      bindingEpoch: share.bindingEpoch,
      shareGeneration: share.shareGeneration,
      firstSeq,
      lastSeq,
      payloadHash: hash,
      draftIDs: drafts.map((draft) => draft.draftID),
      draftHashes: drafts.map((draft) => digest(draft.event)),
      events,
    })
    await Storage.write(batchKey, persisted)
    return Sync.Batch.parse({
      schemaVersion: 1,
      sessionID,
      projectID: bound.binding.projectID,
      bindingEpoch: persisted.bindingEpoch,
      shareGeneration: persisted.shareGeneration,
      firstSeq,
      lastSeq,
      payloadHash: persisted.payloadHash,
      events,
    })
  }

  async function flushSession(sessionID: string) {
    if (!(await sessionBinding(sessionID))) return
    const share = await connection.syncState(sessionID, signal)
    if (share.shareState !== "shared" || share.syncState === "blocked") return
    await prepareGeneration(sessionID, share)
    if (closed || signal.aborted) return
    const batch = await prepare(sessionID, share)
    if (!batch) return
    await uploadBatchBlobs(sessionID, share, batch)
    const bound = await sessionBinding(sessionID)
    if (!bound || bound.binding.bindingEpoch !== batch.bindingEpoch) return
    const ack = Sync.Ack.parse(await connection.sync(batch, signal))
    if (
      ack.sessionID !== batch.sessionID ||
      ack.shareGeneration !== batch.shareGeneration ||
      ack.bindingEpoch !== batch.bindingEpoch ||
      ack.nextSeq < batch.lastSeq + 1
    )
      throw new Error("Runtime sync acknowledgement does not match the sent batch")
    const stored = await read(Batch, Keys.batch(identity.orgID, sessionID))
    if (!stored || stored.payloadHash !== batch.payloadHash) return
    await Storage.transaction(async () => {
      await Storage.remove(Keys.batch(identity.orgID, sessionID))
      for (const [index, draftID] of stored.draftIDs.entries()) {
        const draftKey = Keys.draft(identity.orgID, sessionID, draftID)
        const draft = await read(Draft, draftKey)
        if (!draft || stored.draftHashes?.[index] !== digest(draft.event)) continue
        await Storage.remove(draftKey)
        await Storage.remove(Keys.orderedDraft(identity.orgID, sessionID, draft.localSequence))
      }
      const current = await read(State, Keys.state(identity.orgID, sessionID))
      await Storage.write(
        Keys.state(identity.orgID, sessionID),
        State.parse({
          schemaVersion: 1,
          orgID: identity.orgID,
          sessionID,
          nextDraft: current?.nextDraft ?? 1,
          shareGeneration: current?.shareGeneration,
          syncState: ack.syncState,
          projectionVersion: current?.projectionVersion,
          updatedAt: Date.now(),
        }),
      )
    })
  }

  async function flush() {
    if (running || closed || signal.aborted) return running
    running = (async () => {
      await startup
      for (const sessionID of pendingNative.keys()) startNativeWorker(sessionID)
      await Promise.all([...tails.values()])
      for (const sessionID of [...sessions]) {
        if (closed || signal.aborted) return
        try {
          await flushSession(sessionID)
        } catch {
          if (closed || signal.aborted) return
          const current = await read(State, Keys.state(identity.orgID, sessionID))
          await Storage.write(
            Keys.state(identity.orgID, sessionID),
            State.parse({
              schemaVersion: 1,
              orgID: identity.orgID,
              sessionID,
              nextDraft: current?.nextDraft ?? 1,
              shareGeneration: current?.shareGeneration,
              syncState: "failed",
              projectionVersion: current?.projectionVersion,
              updatedAt: Date.now(),
            }),
          ).catch(() => {})
        }
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }

  unsubs.push(Bus.subscribeGlobal(SessionEvent.Updated, (event) => observeSession(event.properties.info.id)))
  unsubs.push(
    Bus.subscribeGlobal(SessionEvent.Status, (event) =>
      queue(event.properties.sessionID, async () => {
        await ensureSession(event.properties.sessionID, event.properties.status)
      }),
    ),
  )
  unsubs.push(Bus.subscribeGlobal(MessageV2.Event.Updated, (event) => observeMessage(event.properties.info)))
  unsubs.push(
    Bus.subscribeGlobal(MessageV2.Event.PartUpdated, (event) => {
      const part = event.properties.part
      observePart(part)
      if (part.type === "attachment") observeAttachment(part)
      if (part.type === "tool" && part.state.status === "completed")
        for (const attachment of part.state.attachments ?? []) observeAttachment(attachment)
    }),
  )
  unsubs.push(
    Bus.subscribeGlobal(MessageV2.Event.PartRemoved, (event) => {
      const { sessionID, messageID, partID } = event.properties
      observeNative({ kind: "part-removed", sessionID, messageID, partID })
    }),
  )
  unsubs.push(
    Bus.subscribeGlobal(RolloutEvents.Updated, (event) => {
      if (event.properties.owner.kind !== "session") return
      observeTool({ sessionID: event.properties.owner.sessionID, record: event.properties.record })
    }),
  )
  unsubs.push(
    Bus.subscribeGlobal(SessionInbox.Event.Updated, (event) => {
      void observeNotification(event.properties.sessionID, event.properties.items)
    }),
  )
  const startup = (async () => {
    for await (const row of Storage.records<unknown>({ prefix: Keys.roots(identity.orgID), limit: 256 })) {
      if (closed || signal.aborted) return
      sessions.add(z.strictObject({ sessionID: Identity.ID }).parse(row.value).sessionID)
    }
    schedule()
  })()
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()

  function onAbort() {
    void close().catch(() => {})
  }

  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    clearTimeout(timer)
    clearInterval(retryTimer)
    for (const unsubscribe of unsubs) unsubscribe()
    signal.removeEventListener("abort", onAbort)
    closing = (async () => {
      const settled = await Promise.allSettled([startup, ...tails.values(), ...(running ? [running] : [])])
      pendingNative.clear()
      nativeWorkers.clear()
      tails.clear()
      sessions.clear()
      registeredExporters.delete(drain)
      const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Shared transcript exporter cleanup failed")
    })()
    return closing
  }

  return {
    flush: async () => {
      await flush()
    },
    close,
  }
}
