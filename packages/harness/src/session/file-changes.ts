import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { RuntimeContext } from "../lifecycle/context"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { WorkspaceAccess } from "../workspace/access"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceEvidence } from "../workspace/evidence"
import { WorkspaceMounts } from "../workspace/mount"
import { Log } from "../util/log"
import { Snapshot } from "./snapshot"
import { MessageV2 } from "./message-v2"
import type { RolloutLedger } from "./rollout/ledger"
import type { Workspace } from "./workspace-schema"
import { Storage } from "../storage/storage"
import { LoopJob } from "./loop-job"
import type { SnapshotSchema } from "./snapshot-schema"

export namespace SessionFileChanges {
  const log = Log.create({ service: "session.file-changes" })
  type Input = { sessionID: string; rootID: string; segmentID: string }
  type Capture = { workspace: Workspace | null; source: WorkspaceCatalog.Info; part: MessageV2.PatchPart }
  type Segment = Input & { scope: Scope; closed: boolean; captures: Map<string, Promise<Capture>> }
  const state = RuntimeContext.state(() => new Map<string, Segment>())
  const key = (input: Input) => JSON.stringify([input.sessionID, input.segmentID])

  async function capture(segment: Segment, source: WorkspaceCatalog.Info, id: string) {
    const current = await WorkspaceCatalog.get(source.id, segment.scope.id)
    if (
      current.binding.generation !== source.binding.generation ||
      current.binding.state !== "bound" ||
      current.lifecycle !== "active"
    )
      throw new Error("Workspace binding changed during snapshot capture")
    let omissions: SnapshotSchema.Omission[] = []
    const observed = (value: SnapshotSchema.Omission[]) => {
      omissions = value
    }
    if (source.backend?.provider !== "objects")
      return { hash: await Snapshot.track(segment.sessionID, AbortSignal.timeout(30000), observed), omissions }
    let info = current
    if (current.activeMount) {
      if (current.activeMount.state !== "active") throw new Error("Workspace live content is unavailable")
      const files = await WorkspaceMounts.connect(current)
      const checkpoint = await files.checkpoint({ id, mount: WorkspaceMounts.reference(current) })
      info = await WorkspaceMounts.save(current, files, checkpoint)
    }
    return {
      hash: await Snapshot.trackContent(
        info,
        info.content?.manifest ?? null,
        segment.sessionID,
        AbortSignal.timeout(30000),
        observed,
      ),
      omissions,
    }
  }

  async function include(segment: Segment, source: WorkspaceCatalog.Info) {
    if (segment.closed) return
    const identity = JSON.stringify([source.id, source.binding.generation])
    const existing = segment.captures.get(identity)
    if (existing) return existing
    const workspace = source.backend?.provider === "objects" ? null : WorkspaceCatalog.projection(source)
    const pending = ScopeContext.provide({
      scope: segment.scope,
      workspace,
      async fn() {
        const { Session } = await import("./index")
        let part: MessageV2.PatchPart = {
          id: Identifier.ascending("part"),
          sessionID: segment.sessionID,
          messageID: segment.rootID,
          type: "patch",
          hash: "",
          files: [],
          workspace:
            source.backend?.provider === "objects"
              ? { id: source.id, generation: source.binding.generation, root: "", pathKind: "workspace" }
              : Snapshot.workspace(),
          checkpoint: {
            version: 1,
            rootID: segment.rootID,
            segmentID: segment.segmentID,
            started: Date.now(),
            status: "pending",
          },
        }
        await Session.updatePart(part)
        try {
          const { hash, omissions } = await capture(segment, source, `${part.id}:start`)
          if (!hash) throw new Error("Snapshot baseline unavailable")
          part = { ...part, hash, checkpoint: { ...part.checkpoint!, baselineOmissions: omissions } }
        } catch (error) {
          log.warn("baseline capture failed", { error })
          part = { ...part, checkpoint: { ...part.checkpoint!, status: "incomplete", error: "baseline_unavailable" } }
        }
        await Session.updatePart(part)
        return { workspace, source, part }
      },
    })
    segment.captures.set(identity, pending)
    return pending
  }

  export async function begin(input: Input) {
    if ((await Config.current()).snapshot === false || state().has(key(input))) return
    const segment: Segment = { ...input, scope: ScopeContext.current.scope, closed: false, captures: new Map() }
    state().set(key(input), segment)
    const { Session } = await import("./index")
    const workspaceID = ScopeContext.current.workspace?.id ?? (await Session.get(input.sessionID)).workspaceID
    if (workspaceID) await include(segment, await WorkspaceCatalog.get(workspaceID, segment.scope.id))
  }

  export async function finish(input: Input, options?: { deferSummary?: boolean }) {
    const segment = state().get(key(input))
    if (!segment || segment.closed) return
    segment.closed = true
    const { Session } = await import("./index")
    try {
      for (const pending of segment.captures.values()) {
        const { workspace, source, part } = await pending
        await ScopeContext.provide({
          scope: segment.scope,
          workspace,
          async fn() {
            let checkpoint = { ...part.checkpoint!, ended: Date.now() }
            let files: string[] = []
            if (part.hash) {
              try {
                const { hash: afterHash, omissions } = await capture(segment, source, `${part.id}:end`)
                if (!afterHash) throw new Error("Snapshot endpoint unavailable")
                files = await Snapshot.changedPaths(part.hash, afterHash, input.sessionID, AbortSignal.timeout(30000))
                checkpoint = {
                  ...checkpoint,
                  status: "complete",
                  afterHash,
                  omissions,
                }
              } catch (error) {
                log.warn("final capture failed", { error })
                checkpoint = { ...checkpoint, status: "incomplete", error: "capture_failed" }
              }
            }
            await Session.updatePart({ ...part, files, checkpoint })
          },
        })
      }
      if (segment.captures.size) {
        const { SessionSummary } = await import("./summary")
        await ScopeContext.provide({
          scope: segment.scope,
          workspace: null,
          fn: async () => {
            const payload = {
              sessionID: input.sessionID,
              messageID: input.rootID,
              revisionID: input.segmentID,
              diffOnly: true,
            }
            if (
              options?.deferSummary &&
              LoopJob.scheduleDetached({ sessionID: input.sessionID, rootID: input.rootID, type: "summarize", payload })
            )
              return
            await SessionSummary.summarize(payload)
          },
        })
      }
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) log.error("checkpoint publication failed", { error })
    } finally {
      state().delete(key(input))
    }
  }

  export function provide<T>(input: Parameters<typeof RolloutLedger.beginTool>[0], action: () => Promise<T>) {
    const owner = input.owner
    if (owner.kind !== "session") return WorkspaceAccess.observeWrites(undefined, action)
    const segment = [...state().values()].find(
      (value) => value.sessionID === owner.sessionID && value.rootID === input.runID && !value.closed,
    )
    const includeNative = async (workspaces: Workspace[]) => {
      if (!segment || segment.closed) return
      if (segment.scope.id !== owner.scopeID) throw new Error("File changes belong to another Scope")
      for (const workspace of workspaces) {
        if (workspace.id) await include(segment, await WorkspaceCatalog.get(workspace.id, segment.scope.id))
      }
    }
    return WorkspaceEvidence.provide(
      { scopeID: owner.scopeID, sessionID: owner.sessionID, messageID: input.messageID, toolCallID: input.toolCallID },
      () =>
        WorkspaceAccess.observeUses(includeNative, () =>
          WorkspaceAccess.observeWrites(async ({ workspaces }) => {
            await includeNative(workspaces)
            return undefined
          }, action),
        ),
      async (workspace) => {
        if (segment) await include(segment, workspace)
      },
    )
  }
}
