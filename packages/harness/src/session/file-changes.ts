import path from "node:path"
import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { WorkspaceAccess } from "../workspace/access"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"
import { Snapshot } from "./snapshot"
import { MessageV2 } from "./message-v2"
import type { RolloutLedger } from "./rollout/ledger"
import { Storage } from "../storage/storage"
import { ExecutionCapacity } from "./execution-capacity"

export namespace SessionFileChanges {
  const log = Log.create({ service: "session.file-changes" })

  export function provide<T>(input: Parameters<typeof RolloutLedger.beginTool>[0], action: () => Promise<T>) {
    const owner = input.owner
    if (owner.kind !== "session") return WorkspaceAccess.observeWrites(undefined, action)
    let finished = false
    let changed = false
    let revision = 0
    const refresh = async () => {
      try {
        const { SessionSummary } = await import("./summary")
        await SessionSummary.summarize({
          sessionID: owner.sessionID,
          messageID: input.runID,
          revisionID: `${input.messageID}:${input.toolCallID}:${revision}`,
          diffOnly: true,
        })
      } catch (error) {
        if (!(error instanceof Storage.NotFoundError)) log.warn("file summary refresh failed", { error })
      }
    }
    return WorkspaceAccess.observeWrites(
      async ({ roots, workspaces, signal }) => {
        if ((await Config.current()).snapshot === false) return
        const scope = ScopeContext.current.scope
        if (scope.id !== owner.scopeID) throw new Error("File change evidence belongs to another Scope")
        const selected = workspaces.filter(
          (workspace, index) =>
            workspace.id &&
            workspace.generation &&
            workspace.bindingState !== "unbound" &&
            (roots === null ||
              roots.some(
                (root) => Filesystem.contains(workspace.path, root) || Filesystem.contains(root, workspace.path),
              )) &&
            !workspaces.slice(0, index).some((previous) => Filesystem.contains(previous.path, workspace.path)),
        )
        if (!selected.length) return
        const { Session } = await import("./index")
        const pending: Array<{ workspace: (typeof selected)[number]; part: MessageV2.PatchPart }> = []
        for (const workspace of selected) {
          await ScopeContext.provide({
            scope,
            workspace,
            async fn() {
              const source = Snapshot.workspace()!
              let part: MessageV2.PatchPart = {
                id: Identifier.ascending("part"),
                messageID: input.messageID,
                sessionID: owner.sessionID,
                type: "patch",
                hash: "",
                files: [],
                workspace: source,
                operation: { toolCallID: input.toolCallID, status: "pending" },
              }
              await Session.updatePart(part)
              try {
                const hash = await Snapshot.track(owner.sessionID, signal)
                part = hash
                  ? { ...part, hash }
                  : { ...part, operation: { toolCallID: input.toolCallID, status: "incomplete" } }
              } catch (error) {
                log.warn("baseline capture incomplete", { error })
                part = { ...part, operation: { toolCallID: input.toolCallID, status: "incomplete" } }
              }
              await Session.updatePart(part)
              pending.push({ workspace, part })
              changed = true
            },
          })
        }
        return {
          async finish() {
            for (const { workspace, part } of pending) {
              await ScopeContext.provide({
                scope,
                workspace,
                async fn() {
                  let completed: MessageV2.PatchPart = {
                    ...part,
                    operation: { toolCallID: input.toolCallID, status: "incomplete" },
                  }
                  try {
                    await MessageV2.get({ sessionID: owner.sessionID, messageID: input.messageID })
                    if (part.hash) {
                      const afterHash = await Snapshot.track(owner.sessionID, AbortSignal.timeout(30000))
                      if (afterHash) {
                        const files = await Snapshot.changedPaths(
                          part.hash,
                          afterHash,
                          owner.sessionID,
                          AbortSignal.timeout(30000),
                        )
                        completed = {
                          ...part,
                          files: files
                            .map((file) => path.join(workspace.path, file))
                            .filter((file) => roots === null || roots.some((root) => Filesystem.contains(root, file))),
                          operation: { toolCallID: input.toolCallID, status: "complete", afterHash },
                        }
                      }
                    }
                  } catch (error) {
                    if (error instanceof Storage.NotFoundError) return
                    log.warn("final capture incomplete", { error })
                  }
                  try {
                    await Session.updatePart(completed)
                  } catch (error) {
                    if (!(error instanceof Storage.NotFoundError)) throw error
                  }
                },
              })
            }
          },
          async afterRelease() {
            revision++
            if (finished) await ExecutionCapacity.detached(refresh)
          },
        }
      },
      async () => {
        try {
          return await action()
        } finally {
          finished = true
          if (changed) await ExecutionCapacity.wait(refresh)
        }
      },
    )
  }
}
