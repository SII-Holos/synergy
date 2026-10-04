import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useFile } from "@/context/file"
import { useSync } from "@/context/sync"
import { useLingui } from "@lingui/solid"
import { reviewCopy as C } from "./review-copy"
import { createReviewReadQueue } from "./review-read-queue"
import { reviewFileKey } from "@ericsanchezok/synergy-ui/session-review"
import type {
  FileDiff,
  ReviewComparisonFile,
  ReviewFileVersions,
  ReviewStateResult,
  ReviewStateValue,
} from "@ericsanchezok/synergy-sdk/client"

export type ReviewSource = "turn" | "session" | "worktree" | "branch"
export type ReviewContent = ReviewFileVersions & { diff: FileDiff; version: string }
export type ReviewRow = FileDiff & { version?: string }

export function useReviewData(input: {
  source: () => ReviewSource
  messageID: () => string | undefined
  from: () => string
  to: () => string
}) {
  const params = useParams(),
    sdk = useSDK(),
    file = useFile(),
    sync = useSync(),
    { _ } = useLingui()
  const [refresh, setRefresh] = createSignal(0)
  const [revision, setRevision] = createSignal(0)
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [accepted, setAccepted] = createSignal<{
    key: string
    rows: ReviewRow[]
    recording?: { status: string; code?: string }
    endpoints?: { from: string; to: string }
  }>()
  const [storedNotes, setStoredNotes] = createSignal<ReviewStateResult & { key: string }>()
  const cache = new Map<string, ReviewContent>()
  const pending = new Map<string, Promise<ReviewContent | undefined>>()
  const failures = new Map<string, string>()
  const queue = createReviewReadQueue(4)
  let controller = new AbortController()
  let comparisonController = new AbortController()
  let notesController = new AbortController()
  const key = createMemo(() =>
    JSON.stringify([
      sdk.url,
      sdk.scopeKey,
      params.id,
      input.source(),
      input.messageID(),
      file.workspace?.id,
      file.workspace?.generation,
      input.from(),
      input.to(),
    ]),
  )
  const stateKey = createMemo(() => JSON.stringify([sdk.url, sdk.scopeKey, params.id]))
  const sourceKey = () =>
    input.source() === "turn"
      ? `turn:${input.messageID() ?? ""}`
      : input.source() === "branch"
        ? `branch:${input.from()}:${input.to()}`
        : input.source()
  const historical = () => input.source() === "turn" || input.source() === "session"
  const gitInput = () => {
    const workspace = file.workspace
    if (!workspace) throw new Error(_(C.workspaceRequired))
    return {
      source: input.source() as "worktree" | "branch",
      workspaceID: workspace.id,
      generation: workspace.generation,
      from: input.from(),
      to: input.to(),
    }
  }
  createEffect(() => {
    key()
    controller.abort()
    controller = new AbortController()
    cache.clear()
    pending.clear()
    failures.clear()
    setRevision((value) => value + 1)
    setFailure(undefined)
  })
  const requestKey = createMemo(() => {
    const summary = params.id ? sync.session.get(params.id)?.summary : undefined
    return JSON.stringify([key(), refresh(), historical() ? summary : undefined])
  })
  const [comparison] = createResource(requestKey, async () => {
    comparisonController.abort()
    comparisonController = new AbortController()
    const captured = key(),
      source = input.source(),
      sessionID = params.id,
      signal = comparisonController.signal
    if (!sessionID) throw new Error(_(C.sessionRequired))
    let rows: ReviewRow[]
    let recording: { status: string; code?: string } | undefined
    let endpoints: { from: string; to: string } | undefined
    if (source === "turn") {
      const messageID = input.messageID()
      if (!messageID) throw new Error(_(C.noTurn))
      const result = await sdk.client.session.message({ sessionID, messageID }, { signal, throwOnError: true })
      if (result.data?.info.role !== "user") throw new Error(_(C.turnUnavailable))
      rows = result.data.info.summary?.diffs ?? []
      recording = result.data.info.summary?.diffState
    } else if (source === "session") {
      const result = await sdk.client.session.diff({ sessionID }, { signal, throwOnError: true })
      rows = result.data ?? []
      recording = sync.session.get(sessionID)?.summary?.diffState
    } else {
      const result = await sdk.client.review.compare(gitInput(), { signal, throwOnError: true })
      if (!result.data) throw new Error(_(C.comparisonUnavailable))
      rows = result.data.files
      endpoints = { from: result.data.from, to: result.data.to }
    }
    if (signal.aborted || captured !== key()) throw new DOMException("Aborted", "AbortError")
    const value = { key: captured, rows, recording, endpoints }
    setAccepted(value)
    return value
  })
  const rows = () => (accepted()?.key === key() ? accepted()!.rows : [])
  const context = () => (accepted()?.key === key() ? accepted() : undefined)
  const [notes, { refetch: reloadNotes }] = createResource(stateKey, async () => {
    notesController.abort()
    notesController = new AbortController()
    const signal = notesController.signal
    const captured = stateKey(),
      sessionID = params.id
    if (!sessionID) return undefined
    const result = await sdk.client.review.state.get({ sessionID }, { signal, throwOnError: true })
    if (signal.aborted || captured !== stateKey()) throw new DOMException("Aborted", "AbortError")
    const value = result.data ? { key: captured, ...result.data } : undefined
    setStoredNotes(value)
    return value
  })
  const state = () => (storedNotes()?.key === stateKey() ? storedNotes()!.state : undefined)
  const noteEvent = sdk.event.on("review.state.updated", ({ properties }) => {
    if (properties.sessionID === params.id && !saving()) void reloadNotes()
  })
  onCleanup(() => {
    controller.abort()
    comparisonController.abort()
    notesController.abort()
    noteEvent()
  })
  async function save(next: ReviewStateValue) {
    const previous = storedNotes(),
      captured = stateKey(),
      sessionID = params.id
    if (saving() || !previous || previous.key !== captured || !sessionID) return false
    setSaving(true)
    setFailure(undefined)
    try {
      const result = await sdk.client.review.state.update(
        { sessionID, revision: previous.revision, state: next },
        { throwOnError: true },
      )
      if (captured !== stateKey()) return false
      if (result.data) setStoredNotes({ key: captured, ...result.data })
      return Boolean(result.data)
    } catch (error) {
      if (captured === stateKey()) setFailure(errorText(error))
      return false
    } finally {
      setSaving(false)
    }
  }
  async function load(row: ReviewRow, retry = false) {
    const id = reviewFileKey(row)
    if (cache.has(id) && !retry) return cache.get(id)
    if (pending.has(id)) return pending.get(id)
    if (failures.has(id) && !retry) return undefined
    failures.delete(id)
    const captured = key(),
      sessionID = params.id!,
      signal = controller.signal
    const operation = queue
      .run(signal, async () => {
        try {
          let value: ReviewContent
          if (historical()) {
            if (!row.workspace) throw new Error(_(C.authorityUnavailable))
            const query = {
              sessionID,
              messageID: input.source() === "turn" ? input.messageID() : undefined,
              workspaceID: row.workspace.id,
              generation: row.workspace.generation,
              file: row.file,
            }
            const [diff, versions] = await Promise.all([
              sdk.client.session.files.diff(query, { signal, throwOnError: true }),
              sdk.client.session.files.versions(query, { signal, throwOnError: true }),
            ])
            if (!diff.data || !versions.data) throw new Error(_(C.contentUnavailable))
            value = {
              ...versions.data,
              diff: diff.data,
              version: `${versions.data.before.version}:${versions.data.after.version}`,
            }
          } else {
            const result = await sdk.client.review.file(
              { ...gitInput(), file: row.file, version: (row as ReviewComparisonFile).version },
              { signal, throwOnError: true },
            )
            if (!result.data) throw new Error(_(C.contentUnavailable))
            value = result.data
          }
          if (captured !== key() || signal.aborted) return undefined
          cache.set(id, value)
          failures.delete(id)
          let bytes = [...cache.values()].reduce((total, item) => total + item.before.bytes + item.after.bytes, 0)
          for (const [old, item] of cache) {
            if (cache.size <= 48 && bytes <= 24 * 1024 * 1024) break
            if (old === id) continue
            cache.delete(old)
            bytes -= item.before.bytes + item.after.bytes
          }
          return value
        } catch (error) {
          if (captured === key() && !signal.aborted) failures.set(id, errorText(error))
          return undefined
        }
      })
      .catch((error: unknown) => {
        if (!signal.aborted && captured === key()) failures.set(id, errorText(error))
        return undefined
      })
      .finally(() => {
        if (pending.get(id) === operation) {
          pending.delete(id)
          setRevision((value) => value + 1)
        }
      })
    pending.set(id, operation)
    setRevision((value) => value + 1)
    return operation
  }
  return {
    key,
    sourceKey,
    historical,
    rows,
    context,
    comparison,
    state,
    notes,
    save,
    saving,
    failure,
    reloadNotes,
    refresh: () => {
      controller.abort()
      controller = new AbortController()
      cache.clear()
      failures.clear()
      pending.clear()
      setRevision((value) => value + 1)
      setRefresh((value) => value + 1)
    },
    load,
    content: (id: string) => {
      revision()
      return cache.get(id)
    },
    loading: (id: string) => {
      revision()
      return pending.has(id)
    },
    fileError: (id: string) => {
      revision()
      return failures.get(id)
    },
    canOpen: (row: FileDiff) =>
      Boolean(
        file.workspace &&
          row.workspace?.id === file.workspace.id &&
          row.workspace?.generation === file.workspace.generation &&
          row.workspace?.root === file.workspace.path,
      ),
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    error &&
    typeof error === "object" &&
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data
  )
    return String(error.data.message)
  return String(error)
}
