import { Config } from "../config/config"
import { Identifier } from "../id/id"
import { RuntimeContext } from "../lifecycle/context"
import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { WorkspaceAccess } from "../workspace/access"
import { WorkspaceCatalog } from "../workspace/catalog"
import { WorkspaceEvidence } from "../workspace/evidence"
import { WorkspaceMounts } from "../workspace/mount"
import { WorkspaceObservation } from "../workspace/observation"
import path from "node:path"
import { Log } from "../util/log"
import { Snapshot } from "./snapshot"
import { SnapshotStore } from "./snapshot-store"
import { MessageV2 } from "./message-v2"
import type { RolloutLedger } from "./rollout/ledger"
import type { Workspace } from "./workspace-schema"
import { Storage } from "../storage/storage"
import { LoopJob } from "./loop-job"
import { SnapshotSchema } from "./snapshot-schema"
import { SnapshotLive } from "./snapshot-live"
import { SnapshotRanges } from "./snapshot-ranges"
import { SessionFileChangeView } from "./file-change-view"
import { SessionManager } from "./manager"

export namespace SessionFileChanges {
  const log = Log.create({ service: "session.file-changes" })
  type Input = { sessionID: string; rootID: string; segmentID: string }
  type Capture = {
    workspace: Workspace | null
    source: WorkspaceCatalog.Info
    part: MessageV2.PatchPart
    live?: Awaited<ReturnType<typeof SnapshotLive.create>>
    revision?: string
    dirty: Set<string>
    available: boolean
    needsResync: boolean
    close(): void
    diffs: SnapshotSchema.FileDiff[]
    baselineOmissions: SnapshotSchema.Omission[]
    legacy: boolean
    issues: Array<import("zod").infer<typeof SnapshotSchema.Issue>>
  }
  type Segment = Input & {
    scope: Scope
    closed: boolean
    captures: Map<string, Promise<Capture>>
    prior: SnapshotRanges.Range[]
    carried: Array<{ range: SnapshotRanges.Range; files: SnapshotSchema.FileDiff[] }>
    historyRevision: number
    timer?: ReturnType<typeof setTimeout>
    refreshing?: Promise<void>
    revision?: string
    fingerprint?: string
    invalidated?: boolean
  }
  const state = RuntimeContext.state(() => new Map<string, Segment>())
  const revisions = RuntimeContext.state(() => new Map<string, number>())
  const key = (input: Input) => JSON.stringify([input.sessionID, input.segmentID])

  export function revision(sessionID: string, rootID: string) {
    return revisions().get(JSON.stringify([sessionID, rootID])) ?? 0
  }

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

  function markDirty(dirty: Set<string>, paths: readonly string[]) {
    for (const file of paths) {
      if (dirty.has("")) return
      if (!file || dirty.size >= 4096) {
        dirty.clear()
        dirty.add("")
        return
      }
      dirty.add(file)
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
        const dirty = new Set<string>()
        let available = false
        const watcher = workspace
          ? await WorkspaceObservation.subscribe((change) => {
              if (segment.closed) return
              if (change.available !== undefined) available = change.available
              markDirty(dirty, change.paths ?? [""])
              schedule(segment)
            }).catch(() => ({ available: false, close() {} }))
          : { available: false, close() {} }
        available = watcher.available
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
        const previous = segment.prior.find(
          (range) => range.workspace?.id === source.id && range.workspace.generation === source.binding.generation,
        )
        const baseline = previous ? previous.from : part.hash
        const baselineOmissions = previous?.baselineOmissions ?? part.checkpoint?.baselineOmissions ?? []
        const result: Capture = {
          workspace,
          source,
          part,
          dirty,
          needsResync: false,
          get available() {
            return available
          },
          close: watcher.close,
          diffs: [],
          issues: [],
          baselineOmissions,
          legacy: previous?.issue === "legacy_range",
        }
        if (workspace && baseline && part.hash) {
          try {
            result.live = await SnapshotLive.create(segment.sessionID, baseline, part.hash)
            const revision = await result.live.refresh([], part.checkpoint?.baselineOmissions)
            Object.assign(result, { revision, ...(await readFiles(segment, result, revision)) })
          } catch (error) {
            log.warn("live capture unavailable", { error })
            result.issues.push({ workspace: part.workspace, code: "capture_failed" })
            result.needsResync = true
          }
        }
        if (!baseline) result.issues.push({ workspace: part.workspace, code: "baseline_unavailable" })
        if (!result.live && workspace) result.issues.push({ workspace: part.workspace, code: "capture_failed" })
        schedule(segment)
        return result
      },
    })
    segment.captures.set(identity, pending)
    return pending
  }

  export async function begin(input: Input) {
    if ((await Config.current()).snapshot === false || state().has(key(input))) return
    const root = await MessageV2.get({ sessionID: input.sessionID, messageID: input.rootID })
    const segment: Segment = {
      ...input,
      scope: ScopeContext.current.scope,
      closed: false,
      captures: new Map(),
      prior: SnapshotRanges.net(SnapshotRanges.fromMessages([root])),
      carried: [],
      historyRevision: SessionManager.historyRevision(input.sessionID),
    }
    revisions().set(JSON.stringify([input.sessionID, input.rootID]), revision(input.sessionID, input.rootID) + 1)
    state().set(key(input), segment)
    const { Session } = await import("./index")
    const workspaceID = ScopeContext.current.workspace?.id ?? (await Session.get(input.sessionID)).workspaceID
    if (workspaceID) await include(segment, await WorkspaceCatalog.get(workspaceID, segment.scope.id))
    for (const range of segment.prior) {
      if (!range.workspace) continue
      const source = await WorkspaceCatalog.get(range.workspace.id, segment.scope.id).catch(() => undefined)
      if (
        source &&
        source.backend?.provider !== "objects" &&
        source.lifecycle === "active" &&
        source.binding.state === "bound" &&
        source.binding.generation === range.workspace.generation
      )
        await include(segment, source)
      const files =
        range.from && range.to
          ? await Snapshot.statistics(range.from, range.to, segment.sessionID)
              .then((files) =>
                files
                  .filter((file) => !range.omissions?.some((item) => item.file === file.file))
                  .map((file) => ({ ...file, workspace: range.workspace })),
              )
              .catch(() => [])
          : []
      segment.carried.push({ range, files })
    }
    schedule(segment)
  }

  export async function finish(input: Input, options?: { deferSummary?: boolean }) {
    const segment = state().get(key(input))
    if (!segment || segment.closed) return
    segment.closed = true
    const revisionAtFinish = revision(segment.sessionID, segment.rootID)
    clearTimeout(segment.timer)
    await segment.refreshing
    const { Session } = await import("./index")
    try {
      const prepared = await Promise.allSettled(segment.captures.values())
      const captures = prepared.flatMap((result) => {
        if (result.status === "fulfilled") return [result.value]
        log.error("baseline publication failed", { error: result.reason })
        return []
      })
      const settle = async () => {
        for (const capture of captures) capture.close()
        const actions = captures.map(({ workspace, source, part }) => async () => {
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
        })
        const publishing = actions.length === 1 ? actions[0]!() : SnapshotStore.parallel(input.sessionID, actions)
        await publishing.catch((error) => {
          if (!(error instanceof Storage.NotFoundError)) log.error("checkpoint publication failed", { error })
        })
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
                !segment.revision &&
                LoopJob.scheduleDetached({
                  sessionID: input.sessionID,
                  rootID: input.rootID,
                  type: "summarize",
                  payload,
                })
              )
                return
              await SessionSummary.summarize(payload)
            },
          })
        }
      }
      const live = captures.find((capture) => capture.live)?.live
      await (live ? live.withBaselineLease(settle) : settle())
    } catch (error) {
      if (!(error instanceof Storage.NotFoundError)) log.error("checkpoint publication failed", { error })
    } finally {
      const current = await SessionFileChangeView.current(segment.sessionID).catch(() => null)
      if (
        segment.revision &&
        current?.rootID === segment.rootID &&
        current.summary?.diffRevision === segment.revision
      ) {
        const { SessionSummary } = await import("./summary")
        await SessionSummary.publishLive({
          sessionID: segment.sessionID,
          messageID: segment.rootID,
          ...current.summary,
          diffState: { status: "error", code: "incomplete" },
          valid: () => revision(segment.sessionID, segment.rootID) === revisionAtFinish,
        }).catch((error) => log.warn("final summary unavailable", { error }))
        SessionFileChangeView.expireCurrent(segment.revision)
      } else await SessionFileChangeView.releaseCurrent(segment.revision)
      for (const capture of await Promise.allSettled(segment.captures.values()))
        if (capture.status === "fulfilled") {
          capture.value.close()
          await capture.value.live?.close()
        }
      state().delete(key(input))
    }
  }

  export function observing(sessionID: string, rootID: string) {
    return [...state().values()].some(
      (segment) => segment.sessionID === sessionID && segment.rootID === rootID && !segment.closed,
    )
  }

  function schedule(segment: Segment) {
    if (segment.closed) return
    segment.invalidated = true
    if (segment.timer || segment.refreshing) return
    segment.timer = setTimeout(() => {
      segment.timer = undefined
      segment.invalidated = false
      segment.refreshing = refresh(segment)
        .catch((error) => log.warn("live summary failed", { error }))
        .finally(() => {
          segment.refreshing = undefined
          if (!segment.closed)
            void Promise.allSettled(segment.captures.values()).then((results) => {
              const captures = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
              if (segment.invalidated || captures.some((capture) => capture.dirty.size)) schedule(segment)
            })
        })
    }, 150)
    segment.timer.unref()
  }

  async function refresh(segment: Segment) {
    const captures = (await Promise.allSettled(segment.captures.values())).flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    )
    if (!captures.some((capture) => capture.workspace)) return
    for (const capture of captures) {
      if (!capture.live) {
        capture.dirty.clear()
        continue
      }
      if (!capture.dirty.size) continue
      const paths = capture.needsResync ? [""] : [...capture.dirty]
      capture.dirty.clear()
      try {
        await ScopeContext.provide({
          scope: segment.scope,
          workspace: capture.workspace,
          async fn() {
            await WorkspaceCatalog.get(capture.source.id, segment.scope.id).then((source) => {
              if (source.binding.generation !== capture.source.binding.generation || source.binding.state !== "bound")
                throw new Error("Workspace generation changed")
            })
            const revision = await capture.live!.refresh(paths)
            if (revision !== capture.revision || capture.issues.some((issue) => issue.code === "capture_failed")) {
              Object.assign(capture, { revision, ...(await readFiles(segment, capture, revision)) })
            }
            capture.needsResync = false
          },
        })
      } catch (error) {
        log.warn("live refresh failed", { error })
        capture.needsResync = true
        if (!capture.issues.some((issue) => issue.code === "capture_failed"))
          capture.issues.push({ workspace: capture.part.workspace, code: "capture_failed" })
      }
    }
    if (segment.closed || segment.historyRevision !== SessionManager.historyRevision(segment.sessionID)) return
    const carried = segment.carried.filter(
      ({ range }) =>
        !captures.some(
          (capture) =>
            capture.revision &&
            capture.part.workspace?.id === range.workspace?.id &&
            capture.part.workspace?.generation === range.workspace?.generation,
        ),
    )
    const files = [...captures.flatMap((capture) => capture.diffs), ...carried.flatMap((value) => value.files)]
    const issues = captures.flatMap((capture) => capture.issues)
    const recording: import("zod").infer<typeof SnapshotSchema.DiffState> = {
      status: "live",
      ...(issues.length || carried.length || captures.some((capture) => !capture.available)
        ? { code: "incomplete" as const }
        : {}),
    }
    const fingerprint = JSON.stringify([
      captures.map((capture) => [capture.revision, capture.available, capture.issues]),
      carried.map((value) => value.range),
    ])
    if (fingerprint === segment.fingerprint) return
    const revision = SessionFileChangeView.publish({
      sessionID: segment.sessionID,
      rootID: segment.rootID,
      files,
      recording,
      ranges: [
        ...captures.flatMap((capture) =>
          capture.revision && capture.part.workspace
            ? [{ workspace: capture.part.workspace, live: capture.revision }]
            : [],
        ),
        ...carried.flatMap(({ range }) =>
          range.workspace ? [{ workspace: range.workspace, from: range.from, to: range.to }] : [],
        ),
      ],
    })
    const { SessionSummary } = await import("./summary")
    const accepted = await SessionSummary.publishLive({
      sessionID: segment.sessionID,
      messageID: segment.rootID,
      diffs: [],
      diffState: recording,
      diffIssues: issues,
      diffTotals: SnapshotSchema.totals(files),
      diffRevision: revision,
      diffObservedAt: Date.now(),
      valid: () =>
        !segment.closed &&
        state().get(key(segment)) === segment &&
        segment.historyRevision === SessionManager.historyRevision(segment.sessionID),
    })
    if (!accepted) return SessionFileChangeView.releaseCurrent(revision)
    const previous = segment.revision
    segment.revision = revision
    segment.fingerprint = fingerprint
    await SessionFileChangeView.releaseCurrent(previous)
  }

  async function readFiles(segment: Segment, capture: Capture, revision: string) {
    const omissions = await SnapshotLive.read(segment.sessionID, revision, async (value) => [
      ...capture.baselineOmissions,
      ...value.omissions,
    ])
    const omitted = new Set(omissions.map((item) => item.file))
    const diffs = (await Snapshot.liveStatistics(segment.sessionID, revision))
      .filter((diff) => !omitted.has(diff.file))
      .map((diff) => ({ ...diff, workspace: capture.part.workspace }))
    const issues: Capture["issues"] = [
      ...new Map(
        omissions.map((item) => [item.file, { workspace: capture.part.workspace, file: item.file, code: item.reason }]),
      ).values(),
    ]
    if (capture.legacy) issues.push({ workspace: capture.part.workspace, code: "legacy_range" })
    return { diffs, issues }
  }

  export async function stop() {
    for (const segment of state().values()) {
      segment.closed = true
      clearTimeout(segment.timer)
      await segment.refreshing
      for (const capture of await Promise.allSettled(segment.captures.values()))
        if (capture.status === "fulfilled") {
          capture.value.close()
          await capture.value.live?.close()
        }
      await SessionFileChangeView.releaseCurrent(segment.revision)
    }
    state().clear()
    revisions().clear()
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
          WorkspaceAccess.observeWrites(async ({ workspaces, roots }) => {
            await includeNative(workspaces)
            return {
              async finish() {
                if (!segment || segment.closed || !roots?.length) return
                for (const capture of (await Promise.allSettled(segment.captures.values())).flatMap((result) =>
                  result.status === "fulfilled" ? [result.value] : [],
                )) {
                  if (!capture.workspace) continue
                  for (const root of roots) {
                    const relative = path.relative(capture.workspace.path, root)
                    if (
                      relative &&
                      relative !== ".." &&
                      !relative.startsWith(`..${path.sep}`) &&
                      !path.isAbsolute(relative)
                    )
                      markDirty(capture.dirty, [relative.split(path.sep).join("/")])
                  }
                }
                schedule(segment)
              },
            }
          }, action),
        ),
      async (workspace) => {
        if (segment) await include(segment, workspace)
      },
    )
  }
}
