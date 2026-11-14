import { createHash } from "node:crypto"
import { z } from "zod"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionCortexIndex } from "@ericsanchezok/synergy-harness/session/cortex-index"
import { RolloutEvents } from "@ericsanchezok/synergy-harness/session/rollout/events"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"
import type { StatusInfo } from "@ericsanchezok/synergy-harness/session/types"
import { currentRunID, observeSessionStatus } from "./session-status"
import { readCommandControlVersion } from "./command-intake"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { projectSharedPart } from "./transcript"
import { ProjectionRecord, type Bound, type DraftInput } from "./sync-outbox"

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
function safeSummary(value: string | undefined, limit = 32 * 1024) {
  return value?.slice(0, limit) ?? ""
}
function read<T>(schema: z.ZodType<T>, key: string[]) {
  return Storage.readMany<unknown>([key]).then(([value]) => (value === undefined ? undefined : schema.parse(value)))
}

export const AttachmentRecord = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  attachmentID: Identity.ID,
  scopeID: z.string().min(1),
  artifact: RolloutArtifact.Ref,
})
export type AttachmentRecord = z.infer<typeof AttachmentRecord>

export const BlobRecord = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: Identity.ID,
  owner: RolloutArtifact.Owner,
  artifact: RolloutArtifact.Ref,
})
export type BlobRecord = z.infer<typeof BlobRecord>

export async function retainAttachmentContent(
  orgID: string,
  input: AttachmentRecord,
  publish: (key: string[], value: AttachmentRecord) => Promise<void>,
): Promise<AttachmentRecord | undefined> {
  const value = AttachmentRecord.parse(input)
  const artifact = value.artifact
  if (artifact.status !== "complete" || !artifact.sha256) return
  const key = Keys.attachmentContent(orgID, value.sessionID, value.attachmentID, artifact.sha256, artifact.bytes)
  const retained = await read(AttachmentRecord, key)
  if (retained) {
    if (
      retained.sessionID !== value.sessionID ||
      retained.attachmentID !== value.attachmentID ||
      retained.scopeID !== value.scopeID ||
      retained.artifact.status !== "complete" ||
      retained.artifact.sha256 !== artifact.sha256 ||
      retained.artifact.bytes !== artifact.bytes
    )
      throw new Error("Original attachment content reference changed its native identity")
    return retained
  }
  await publish(key, value)
  return value
}

export function createSyncProjection(input: {
  orgID: string
  binding(sessionID: string): Promise<Bound | undefined>
  putDrafts(rootSessionID: string, values: DraftInput[], original?: Bound): Promise<void>
  write(bound: Bound, key: string[], value: unknown): Promise<void>
  waitForChild?(sessionID: string): Promise<void | undefined> | undefined
}) {
  const identity = { orgID: input.orgID }
  const sessionBinding = input.binding
  const putDrafts = input.putDrafts
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
    await retainAttachmentContent(
      identity.orgID,
      AttachmentRecord.parse({
        schemaVersion: 1,
        sessionID,
        attachmentID: part.id,
        scopeID: bound.session.scope.id,
        artifact,
      }),
      (key, value) => input.write(bound, key, value),
    )
    await input.write(
      bound,
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
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    await input.write(
      bound,
      Keys.blob(identity.orgID, sessionID, artifact.id),
      BlobRecord.parse({ schemaVersion: 1, sessionID, owner, artifact }),
    )
  }

  async function projectSession(sessionID: string) {
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    await ensureSession(sessionID, (await SessionManager.statusesFor([bound.session]))[sessionID] ?? { type: "idle" })
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

  async function projectTool(event: { sessionID: string; record: RolloutEvents.Record }) {
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
  }

  async function projectAttachment(part: MessageV2.AttachmentPart) {
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
    const bound = await sessionBinding(part.sessionID)
    if (!bound) return
    await ensureSession(part.sessionID)
    await rememberAttachment(part.sessionID, part)
    await putDraft(
      bound.rootSessionID,
      digest({ type: "attachment", sessionID: part.sessionID, attachmentID: part.id }).slice(0, 32),
      attachment,
    )
  }

  async function projectNotification(value: {
    sessionID: string
    notificationID: string
    taskID: string
    createdAt: number
    summary: string
  }) {
    const { sessionID, taskID } = value
    const bound = await sessionBinding(sessionID)
    if (!bound) return
    let cursor: string | undefined
    let child: Session.Info | undefined
    do {
      const page = await SessionCortexIndex.page(bound.session.scope.id, sessionID, { limit: 64, cursor })
      const selected = page.items.find((candidate) => candidate.taskID === taskID)
      if (selected) {
        child = await Session.get(selected.sessionID)
        if (
          child.parentID !== sessionID ||
          child.cortex?.taskID !== taskID ||
          child.scope.id !== bound.session.scope.id
        )
          throw new Error("Shared notification changed its original Cortex owner")
        break
      }
      cursor = page.cursor
    } while (cursor)
    if (!child?.cortex) return
    await input.waitForChild?.(child.id)
    const summary = (await SecretMask.apply(value.summary)).slice(0, 32 * 1024)
    const safe = {
      notificationID: value.notificationID,
      taskID,
      childSessionID: child.id,
      status: child.cortex.status,
      summary,
    }
    await putDraft(
      bound.rootSessionID,
      digest({ type: "notification", sessionID, notificationID: value.notificationID }).slice(0, 32),
      Sync.Event.parse({
        type: "notification",
        sequence: 1,
        sessionID,
        notificationID: value.notificationID,
        kind: "cortex-completion",
        taskID,
        childSessionID: child.id,
        status: child.cortex.status,
        createdAt: value.createdAt,
        summary,
        integrity: digest(safe),
      }),
    )
  }

  return {
    ensureSession,
    partDrafts,
    messageDraft,
    projectPart,
    projectMessage,
    projectSession,
    projectTool,
    projectAttachment,
    projectNotification,
  }
}
