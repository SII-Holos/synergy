import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { ScopeContext } from "../scope/context"
import { Snapshot } from "./snapshot"
import { SnapshotLive } from "./snapshot-live"
import { SnapshotSchema } from "./snapshot-schema"
import { SnapshotRanges } from "./snapshot-ranges"
import { SessionHistory } from "./history"
import { SessionManager } from "./manager"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"

export namespace SessionFileChangeView {
  export type Range = { workspace: SnapshotSchema.Workspace; from?: string; to?: string; live?: string }
  type View = {
    scopeID: string
    sessionID: string
    rootID: string
    ranges: Range[]
    files: SnapshotSchema.FileDiff[]
    recording: z.infer<typeof SnapshotSchema.DiffState>
    release: Array<() => Promise<void>>
    readers: number
    current: boolean
    timer?: ReturnType<typeof setTimeout>
  }
  type Lease = { view: View; timer: ReturnType<typeof setTimeout> }
  const state = RuntimeContext.state(() => ({ views: new Map<string, View>(), leases: new Map<string, Lease>() }))
  export const Current = z
    .object({ rootID: z.string(), createdAt: z.number(), summary: MessageV2.User.shape.summary })
    .nullable()
    .meta({ ref: "CurrentTurnChanges" })
  export const Comparison = z
    .object({
      revision: z.string(),
      files: SnapshotSchema.FileDiff.array(),
      recording: SnapshotSchema.DiffState.optional(),
    })
    .meta({ ref: "TurnFileComparison" })

  async function requireSession(sessionID: string) {
    const session = await SessionManager.requireSession(sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Storage.NotFoundError({ message: "Session not found in this Scope" })
    return session
  }

  export async function current(sessionID: string) {
    const session = await requireSession(sessionID)
    const rootID = await SessionHistory.latestRootID(sessionID)
    if (!rootID) return null
    const root = await Storage.read<MessageV2.User>(
      StoragePath.messageInfo(
        Identifier.asScopeID(session.scope.id),
        Identifier.asSessionID(sessionID),
        Identifier.asMessageID(rootID),
      ),
    )
    const summary = root.summary ? { ...root.summary, diffs: [] } : undefined
    if (summary?.diffRevision && !state().views.has(summary.diffRevision))
      summary.diffState = { status: "error", code: "incomplete" }
    return { rootID, createdAt: root.time.created, summary }
  }

  async function dispose(view: View) {
    if (view.current || view.readers) return
    const releases = view.release.splice(0)
    await Promise.all(releases.map((release) => release()))
  }

  export function publish(input: Omit<View, "scopeID" | "release" | "readers" | "current">) {
    const view: View = { ...input, scopeID: ScopeContext.current.scope.id, release: [], readers: 0, current: true }
    try {
      for (const range of view.ranges)
        if (range.live) view.release.push(SnapshotLive.retain(input.sessionID, range.live))
    } catch (error) {
      view.current = false
      void dispose(view)
      throw error
    }
    const revision = crypto.randomUUID()
    state().views.set(revision, view)
    return revision
  }

  export async function releaseCurrent(revision?: string) {
    if (!revision) return
    const view = state().views.get(revision)
    if (!view) return
    state().views.delete(revision)
    clearTimeout(view.timer)
    view.current = false
    await dispose(view)
  }

  export function expireCurrent(revision?: string) {
    if (!revision) return
    const view = state().views.get(revision)
    if (!view || view.timer) return
    view.timer = setTimeout(() => {
      void releaseCurrent(revision)
    }, 5 * 60_000)
    view.timer.unref()
  }

  function matches(view: View, sessionID: string, rootID?: string) {
    return (
      view.scopeID === ScopeContext.current.scope.id &&
      view.sessionID === sessionID &&
      (!rootID || view.rootID === rootID)
    )
  }

  export async function acquire(sessionID: string, rootID: string, revision?: string) {
    await requireSession(sessionID)
    let view = revision ? state().views.get(revision) : undefined
    if (view && !matches(view, sessionID, rootID)) view = undefined
    if (revision && !view)
      throw new SnapshotLive.Unavailable({ message: "This live comparison expired; refresh the recorded changes" })
    if (!view) {
      const messages = await SessionHistory.turnMessages({ sessionID, rootID })
      const root = messages.find((message) => message.info.id === rootID)?.info
      if (root?.role !== "user") throw new SnapshotLive.Unavailable({ message: "This turn is unavailable" })
      if (root.summary?.diffRevision) return acquire(sessionID, rootID, root.summary.diffRevision)
      const ranges = SnapshotRanges.net(SnapshotRanges.fromMessages(messages))
      const files = (
        await Promise.all(
          ranges.map(async (range) => {
            if (!range.from || !range.to || !range.workspace) return []
            return (await Snapshot.statistics(range.from, range.to, sessionID))
              .filter((file) => !range.omissions?.some((item) => item.file === file.file))
              .map((file) => ({ ...file, workspace: range.workspace }))
          }),
        )
      ).flat()
      view = {
        scopeID: ScopeContext.current.scope.id,
        sessionID,
        rootID,
        files,
        ranges: ranges.flatMap((range) =>
          range.workspace ? [{ workspace: range.workspace, from: range.from, to: range.to }] : [],
        ),
        recording: root.summary?.diffState ?? { status: "ready" },
        release: [],
        readers: 0,
        current: false,
      }
    }
    view.readers++
    const token = crypto.randomUUID()
    const timer = setTimeout(() => {
      void release(sessionID, token)
    }, 5 * 60_000)
    timer.unref()
    state().leases.set(token, { view, timer })
    return { revision: token, files: view.files, recording: view.recording }
  }

  export async function release(sessionID: string, revision: string) {
    const lease = state().leases.get(revision)
    if (!lease || !matches(lease.view, sessionID)) return
    state().leases.delete(revision)
    clearTimeout(lease.timer)
    lease.view.readers--
    await dispose(lease.view)
  }

  export async function read<T>(
    input: {
      sessionID: string
      messageID?: string
      revision: string
      workspaceID: string
      generation: number
      file: string
    },
    action: (range: Range) => Promise<T>,
  ) {
    await requireSession(input.sessionID)
    const lease = state().leases.get(input.revision)
    if (!lease || !matches(lease.view, input.sessionID, input.messageID))
      throw new SnapshotLive.Unavailable({ message: "This comparison expired; refresh the recorded changes" })
    const range = lease.view.ranges.find(
      (range) => range.workspace.id === input.workspaceID && range.workspace.generation === input.generation,
    )
    if (
      !range ||
      !lease.view.files.some(
        (file) =>
          file.file === input.file &&
          file.workspace?.id === input.workspaceID &&
          file.workspace.generation === input.generation,
      )
    )
      throw new SnapshotLive.Unavailable({ message: "This file is outside the recorded comparison" })
    lease.timer.refresh()
    lease.view.readers++
    try {
      return await action(range)
    } finally {
      lease.view.readers--
      await dispose(lease.view)
    }
  }

  export async function stop() {
    for (const [token, lease] of state().leases) {
      clearTimeout(lease.timer)
      state().leases.delete(token)
      lease.view.readers--
      await dispose(lease.view)
    }
    for (const revision of state().views.keys()) await releaseCurrent(revision)
  }
}
