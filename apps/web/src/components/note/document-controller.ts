import { batch, createSignal } from "solid-js"
import { z } from "zod"
import type { DocumentEditorRetention } from "./document-editor-core"
import type { NoteInfo, NotePatchInput } from "@ericsanchezok/synergy-sdk/client"
import {
  clearCapturedDirty,
  deepEqual,
  dirtyConflicts,
  EMPTY_DIRTY_REVISIONS,
  hasDirtyFields,
  noteChangedFields,
  type NoteChangedField,
  type NoteDirtyField,
  type NoteDirtyRevisions,
} from "./note-sync"

const baselineSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    version: z.number().int().positive(),
    content: z.unknown(),
    tags: z.array(z.string()),
    pinned: z.boolean(),
    global: z.boolean(),
    archived: z.boolean(),
    time: z.object({ created: z.number(), updated: z.number() }),
  })
  .passthrough()
const draftSchema = z.object({
  version: z.literal(1),
  base: baselineSchema,
  title: z.string(),
  tags: z.array(z.string()),
  content: z.unknown(),
  dirty: z.object({
    title: z.number().nonnegative(),
    tags: z.number().nonnegative(),
    content: z.number().nonnegative(),
  }),
  revision: z.number().nonnegative(),
  scroll: z.number().nonnegative().default(0),
  selection: z.object({ from: z.number().nonnegative(), to: z.number().nonnegative() }).optional(),
})

export function migrateNoteDocumentDraft(value: unknown): unknown {
  const result = draftSchema.safeParse(value)
  return result.success ? result.data : null
}

export function noteConflictSnapshot(error: unknown): NoteInfo | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return
  const data = error.data
  if (
    !data ||
    typeof data !== "object" ||
    !("statusCode" in data) ||
    data.statusCode !== 409 ||
    !("responseBody" in data)
  )
    return
  if (typeof data.responseBody !== "string") return
  try {
    const parsed = JSON.parse(data.responseBody)
    if (parsed.name !== "NoteConflictError") return
    return parsed.data?.note
  } catch {
    return
  }
}

export function createNoteDocumentController(input: {
  id: string
  recover?: unknown
  persist: (draft: unknown) => unknown
  backupAvailable?: boolean
  update: (patch: NotePatchInput) => Promise<NoteInfo>
}) {
  const parsed = draftSchema.safeParse(input.recover)
  const recovered = parsed.success && parsed.data.base.id === input.id ? parsed.data : undefined
  const [base, setBase] = createSignal<NoteInfo | null>(recovered ? (recovered.base as NoteInfo) : null)
  const [title, setTitle] = createSignal(recovered?.title ?? "")
  const [tags, setTags] = createSignal(recovered?.tags ?? [])
  const [content, setContent] = createSignal<unknown>(recovered?.content)
  const [dirty, setDirty] = createSignal<NoteDirtyRevisions>(recovered?.dirty ?? { ...EMPTY_DIRTY_REVISIONS })
  const [conflict, setConflict] = createSignal<{ type: "remote-update"; remote: NoteInfo } | null>(null)
  const [error, setError] = createSignal<unknown>()
  const [saving, setSaving] = createSignal(false)
  const [deleted, setDeleted] = createSignal(false)
  const [backupUnavailable, setBackupUnavailable] = createSignal(input.backupAvailable === false)
  let revision = recovered?.revision ?? 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes = Promise.resolve()
  let disposed = false
  let pending: NotePatchInput | undefined
  const view: DocumentEditorRetention = { scroll: recovered?.scroll ?? 0, selection: recovered?.selection }

  function persist() {
    const snapshot = base()
    try {
      setBackupUnavailable(
        input.persist(
          snapshot
            ? {
                version: 1,
                base: snapshot,
                title: title(),
                tags: tags(),
                content: content(),
                dirty: dirty(),
                revision,
                scroll: view.scroll,
                selection: view.selection,
              }
            : null,
        ) === false,
      )
    } catch {
      setBackupUnavailable(true)
    }
  }
  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }
  function schedule() {
    clearTimer()
    if (disposed) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, 1000)
  }
  function ingest(snapshot: NoteInfo, changed?: NoteChangedField[]) {
    if (snapshot.id !== input.id) return false
    const previous = base()
    if (previous && snapshot.version <= previous.version) return true
    const fields = changed ?? (previous ? noteChangedFields(previous, snapshot) : [])
    const overlap = dirtyConflicts(dirty(), fields)
    const ownUpdate =
      pending &&
      snapshot.version === (pending.expectedVersion ?? 0) + 1 &&
      overlap.every((field) => field in pending! && deepEqual(snapshot[field], pending![field]))
    if (previous && overlap.length && !ownUpdate) {
      setConflict({ type: "remote-update", remote: snapshot })
      persist()
      return false
    }
    batch(() => {
      setBase(snapshot)
      if (!dirty().title) setTitle(snapshot.title)
      if (!dirty().tags) setTags(snapshot.tags ?? [])
      if (!dirty().content) setContent(() => snapshot.content)
      setConflict(null)
      setDeleted(false)
    })
    persist()
    return true
  }
  function edit(field: NoteDirtyField, value: unknown) {
    if (field === "title" && typeof value === "string") setTitle(value)
    if (field === "tags" && Array.isArray(value) && value.every((item) => typeof item === "string")) setTags(value)
    if (field === "content") setContent(() => value)
    setDirty((current) => ({ ...current, [field]: ++revision }))
    setError(undefined)
    persist()
    schedule()
  }
  function enqueue<T>(operation: () => Promise<T>) {
    const job = writes.then(operation)
    writes = job.then(
      () => {},
      () => {},
    )
    return job
  }
  async function saveDirty() {
    if (deleted()) return !hasDirtyFields(dirty())
    let retry = 0
    while (hasDirtyFields(dirty()) && !conflict() && !deleted()) {
      const snapshot = base()
      if (!snapshot) return false
      const captured = { ...dirty() }
      const patch: NotePatchInput = { expectedVersion: snapshot.version }
      if (captured.title) patch.title = title()
      if (captured.tags) patch.tags = tags()
      if (captured.content) patch.content = content()
      try {
        pending = patch
        const saved = await input.update(patch)
        batch(() => {
          setDirty((current) => clearCapturedDirty(current, captured))
          if (!base() || saved.version > base()!.version) setBase(saved)
          if (!dirty().title) setTitle(saved.title)
          if (!dirty().tags) setTags(saved.tags ?? [])
          if (!dirty().content) setContent(() => saved.content)
          setError(undefined)
          if ((conflict()?.remote.version ?? 0) <= saved.version) setConflict(null)
        })
        persist()
      } catch (failure) {
        const remote = noteConflictSnapshot(failure)
        if (remote && retry++ === 0 && ingest(remote)) continue
        setError(() => failure)
        persist()
        return false
      } finally {
        pending = undefined
      }
    }
    return !conflict() && !deleted() && !hasDirtyFields(dirty())
  }
  function flush() {
    clearTimer()
    return enqueue(async () => {
      setSaving(true)
      try {
        return await saveDirty()
      } finally {
        setSaving(false)
      }
    })
  }
  function mutate(build: (snapshot: NoteInfo) => NotePatchInput) {
    clearTimer()
    return enqueue(async () => {
      setSaving(true)
      try {
        if (!(await saveDirty())) return false
        for (let attempt = 0; attempt < 2; attempt++) {
          const snapshot = base()
          if (!snapshot || deleted()) return false
          try {
            pending = build(snapshot)
            const saved = await input.update(pending)
            // Metadata responses cannot replace edits made while the request was in flight.
            if (!base() || saved.version > base()!.version) setBase(saved)
            if (!dirty().title) setTitle(saved.title)
            if (!dirty().tags) setTags(saved.tags ?? [])
            if (!dirty().content) setContent(() => saved.content)
            setError(undefined)
            persist()
            return true
          } catch (failure) {
            const remote = noteConflictSnapshot(failure)
            if (remote && attempt === 0 && ingest(remote)) continue
            setError(() => failure)
            return false
          } finally {
            pending = undefined
          }
        }
        return false
      } finally {
        setSaving(false)
      }
    })
  }
  return {
    base,
    title,
    tags,
    content,
    dirty,
    conflict,
    error,
    saving,
    deleted,
    backupUnavailable,
    view,
    ingest,
    edit,
    flush,
    mutate,
    persist,
    reloadRemote() {
      const remote = conflict()?.remote
      if (!remote) return
      setDirty({ ...EMPTY_DIRTY_REVISIONS })
      setBase(null)
      setError(undefined)
      ingest(remote)
    },
    overwriteRemote() {
      const remote = conflict()?.remote
      if (!remote) return Promise.resolve(false)
      setBase(remote)
      setConflict(null)
      return flush()
    },
    markDeleted() {
      setDeleted(true)
      clearTimer()
      persist()
    },
    dispose() {
      disposed = true
      clearTimer()
      persist()
      view.editor?.destroy()
    },
  }
}

export type NoteDocumentController = ReturnType<typeof createNoteDocumentController>
