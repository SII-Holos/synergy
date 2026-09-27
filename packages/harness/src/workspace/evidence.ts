import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { Snapshot } from "../session/snapshot"
import { MessageV2 } from "../session/message-v2"
import { Storage } from "../storage/storage"
import type { WorkspaceCatalog } from "./catalog"
import { Log } from "../util/log"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"

export namespace WorkspaceEvidence {
  export const Owner = z.object({
    scopeID: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    toolCallID: z.string(),
  })
  export const Reference = Owner.extend({ partID: z.string() })
  export type Reference = z.infer<typeof Reference>
  const context = RuntimeContext.createAsyncContext<
    { runtime: RuntimeContext.Instance; owner: z.infer<typeof Owner> } | undefined
  >()

  export function provide<T>(owner: z.infer<typeof Owner> | undefined, action: () => Promise<T>) {
    return context.run(owner ? { runtime: RuntimeContext.current(), owner } : undefined, action)
  }

  export async function begin(workspace: WorkspaceCatalog.Info): Promise<Reference | undefined> {
    const current = context.getStore()
    if (
      !current ||
      current.runtime !== RuntimeContext.current() ||
      workspace.backend?.provider !== "objects" ||
      (await Config.current()).snapshot === false
    )
      return
    if (current.owner.scopeID !== workspace.scopeID) throw new Error("Workspace evidence belongs to another Scope")
    const reference = { ...current.owner, partID: Identifier.ascending("part") }
    const { Session } = await import("../session")
    await Session.updatePart({
      id: reference.partID,
      sessionID: reference.sessionID,
      messageID: reference.messageID,
      type: "patch",
      hash: "",
      files: [],
      workspace: { id: workspace.id, generation: workspace.binding.generation, root: "", pathKind: "workspace" },
      operation: { toolCallID: reference.toolCallID, status: "pending" },
    })
    return reference
  }

  export async function incomplete(reference: Reference | undefined) {
    if (!reference) return
    const scope = await Scope.fromID(reference.scopeID)
    if (!scope) return
    try {
      await ScopeContext.provide({
        scope,
        workspace: null,
        fn: () =>
          Storage.transaction(async () => {
            const message = await MessageV2.get({ sessionID: reference.sessionID, messageID: reference.messageID })
            const part = message.parts.find(
              (part): part is MessageV2.PatchPart => part.id === reference.partID && part.type === "patch",
            )
            if (!part || part.operation?.status !== "pending") return
            const { Session } = await import("../session")
            await Session.updatePart({ ...part, operation: { toolCallID: reference.toolCallID, status: "incomplete" } })
          }),
      })
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) throw error
    }
  }

  export async function finish(
    reference: Reference | undefined,
    workspace: WorkspaceCatalog.Info,
    before: string | null,
    after: string | null,
  ) {
    if (!reference) return
    if (reference.scopeID !== workspace.scopeID) throw new Error("Workspace evidence belongs to another Scope")
    const scope = await Scope.fromID(reference.scopeID)
    if (!scope) return
    await ScopeContext.provide({ scope, workspace: null, fn: () => finishOwned(reference, workspace, before, after) })
  }

  async function finishOwned(
    reference: Reference,
    workspace: WorkspaceCatalog.Info,
    before: string | null,
    after: string | null,
  ) {
    const message = await MessageV2.get({ sessionID: reference.sessionID, messageID: reference.messageID }).catch(
      (error) => {
        if (error instanceof Storage.NotFoundError) return undefined
        throw error
      },
    )
    const part = message?.parts.find(
      (part): part is MessageV2.PatchPart => part.id === reference.partID && part.type === "patch",
    )
    if (!part || part.operation?.status === "complete") return
    const hash = await Snapshot.trackContent(workspace, before, reference.sessionID)
    const afterHash = await Snapshot.trackContent(workspace, after, reference.sessionID)
    const files = await Snapshot.changedPaths(hash, afterHash, reference.sessionID)
    const { Session } = await import("../session")
    try {
      await Session.updatePart({
        ...part,
        hash,
        files,
        operation: { toolCallID: reference.toolCallID, status: "complete", afterHash },
      })
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return
      throw error
    }
    try {
      const { SessionSummary } = await import("../session/summary")
      await SessionSummary.summarize({
        sessionID: reference.sessionID,
        messageID: message!.info.rootID ?? reference.messageID,
        revisionID: reference.partID,
        diffOnly: true,
      })
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError))
        Log.create({ service: "workspace-evidence" }).warn("File summary refresh failed", { error })
    }
  }
}
