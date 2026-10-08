import { z } from "zod"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"

export namespace Render {
  export const Unavailable = NamedError.create("RenderUnavailable", z.object({ message: z.string() }))
  export const Conflict = NamedError.create(
    "RenderConflict",
    z.object({ message: z.string(), state: RenderArtifact.State }),
  )

  async function owned(target: RenderArtifact.Target) {
    const session = await Session.get(target.sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Unavailable({ message: "Visual belongs to another Scope" })
    await SessionHistory.requireDisplayMessage(session, target.messageID)
    const part = await Storage.read<MessageV2.Part>(
      StoragePath.messagePart(
        Identifier.asScopeID(session.scope.id),
        Identifier.asSessionID(target.sessionID),
        Identifier.asMessageID(target.messageID),
        Identifier.asPartID(target.partID),
      ),
    )
    const descriptor =
      part.type === "tool" && part.tool === "render" && part.state.status === "completed"
        ? RenderArtifact.descriptor(part.state.metadata)
        : undefined
    if (
      !descriptor ||
      part.type !== "tool" ||
      part.state.status !== "completed" ||
      !part.state.attachments?.some((file) => file.mime === RenderArtifact.MIME && file.url === descriptor.source)
    )
      throw new Unavailable({ message: "Visual source is not owned by this completed render call" })
    return { part: { ...part, state: part.state }, descriptor, state: RenderArtifact.state(part.state.metadata) }
  }

  export async function read(target: RenderArtifact.Target) {
    const { descriptor, state } = await owned(RenderArtifact.Target.parse(target))
    const file = await Asset.read(descriptor.source.slice("asset://".length))
    if (!file) throw new Unavailable({ message: "Visual source is missing" })
    const bytes = Buffer.from(await file.arrayBuffer())
    if (`asset://${Asset.generateId(bytes, RenderArtifact.MIME)}` !== descriptor.source)
      throw new Unavailable({ message: "Visual source integrity check failed" })
    const source = RenderArtifact.Source.parse(JSON.parse(bytes.toString()))
    const { html: _, ...identity } = source
    if (
      JSON.stringify(RenderArtifact.Descriptor.parse({ ...identity, source: descriptor.source })) !==
      JSON.stringify(descriptor)
    )
      throw new Unavailable({ message: "Visual descriptor does not match its source" })
    return { descriptor, source, state }
  }

  export async function write(target: RenderArtifact.Target, input: RenderArtifact.Write) {
    RenderArtifact.Target.parse(target)
    const update = RenderArtifact.Write.parse(input)
    return Storage.transaction(async () => {
      const { part, descriptor, state } = await owned(target)
      if (descriptor.mode !== "interactive") throw new Unavailable({ message: "Static visuals cannot save state" })
      if (state.mutationID === update.mutationID && JSON.stringify(state.content) === JSON.stringify(update.content))
        return state
      if (state.revision !== update.revision || state.mutationID === update.mutationID)
        throw new Conflict({ message: "Visual state changed in another view. Reload before editing.", state })
      const next = {
        revision: state.revision + 1,
        updatedAt: Date.now(),
        mutationID: update.mutationID,
        content: update.content,
      }
      await Session.updatePart({
        ...part,
        state: { ...part.state, metadata: { ...part.state.metadata, visualState: next } },
      })
      return next
    })
  }

  export async function find(sessionID: string, source: string) {
    const session = await Session.get(sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Unavailable({ message: "Visual belongs to another Scope" })
    for await (const { value } of Storage.records<MessageV2.Part>({
      kind: "part",
      scopeID: session.scope.id,
      sessionID,
    })) {
      if (value.type !== "tool" || value.tool !== "render" || value.state.status !== "completed") continue
      const descriptor = RenderArtifact.descriptor(value.state.metadata)
      if (descriptor?.source !== source) continue
      const target = { sessionID, messageID: value.messageID, partID: value.id }
      try {
        await owned(target)
      } catch (error) {
        if (error instanceof Storage.NotFoundError) return null
        throw error
      }
      return { target, descriptor }
    }
    return null
  }

  export async function assertVersion(sessionID: string, id: string) {
    const session = await Session.get(sessionID)
    for await (const { value } of Storage.records<MessageV2.Part>({
      kind: "part",
      scopeID: session.scope.id,
      sessionID,
    })) {
      if (
        value.type === "tool" &&
        value.tool === "render" &&
        value.state.status === "completed" &&
        RenderArtifact.descriptor(value.state.metadata)?.id === id
      ) {
        await SessionHistory.requireDisplayMessage(session, value.messageID)
        return
      }
    }
    throw new Unavailable({ message: "Replacement visual is not in this session" })
  }
}
