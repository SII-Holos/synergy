import { createMemo, createResource, createSignal, For, Show, createEffect, onCleanup, untrack } from "solid-js"
import { useParams } from "@solidjs/router"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import { Table } from "@tiptap/extension-table"
import { TableRow } from "@tiptap/extension-table-row"
import { TableHeader } from "@tiptap/extension-table-header"
import { TableCell } from "@tiptap/extension-table-cell"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import CodeBlockShiki from "tiptap-extension-code-block-shiki"
import MathExtension from "@aarkue/tiptap-math-extension"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"

import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { Video, Mermaid, CrossCellSelection, createFileUpload } from "@/components/note/extensions"
import { createSlashCommands } from "@/components/note/slash-menu"
import { createBubbleMenu, BubbleMenuContent } from "@/components/note/bubble-menu"
import type { NoteInfo, NoteMetaInfo, NoteMetaScopeGroup } from "@ericsanchezok/synergy-sdk/client"
import { getScopeLabel } from "@/utils/scope"
import { assetHttpUrl } from "@/utils/asset-url"
import { relativeTime } from "@/utils/time"
import "./note-panel.css"

function attachNoteDragData(e: DragEvent, note: NoteMetaInfo) {
  const title = note.title || "Untitled"
  const payload = JSON.stringify({
    id: note.id,
    title: note.title,
    content: note.searchText,
  })

  e.dataTransfer!.effectAllowed = "copy"
  e.dataTransfer!.setData("application/x-synergy-note", payload)
  e.dataTransfer!.setData("text/plain", title)

  const dragImage = document.createElement("div")
  dragImage.className =
    "flex items-center gap-2 rounded-xl border border-border-weak-base bg-surface-raised-base/95 px-3 py-2 text-12-medium text-text-base shadow-[0_14px_36px_rgba(28,34,48,0.12)]"
  dragImage.style.position = "absolute"
  dragImage.style.top = "-1000px"
  dragImage.textContent = title
  document.body.appendChild(dragImage)
  e.dataTransfer!.setDragImage(dragImage, 0, 16)
  setTimeout(() => document.body.removeChild(dragImage), 0)
}

function NoteCard(props: { note: NoteMetaInfo; originName?: string; onClick: () => void }) {
  const previewHtml = createMemo(() => props.note.previewHtml ?? null)
  const searchPreview = createMemo(() => props.note.searchText ?? "")
  const hasContent = createMemo(() => (previewHtml() ?? searchPreview()).length > 0)

  return (
    <button
      type="button"
      class="group note-card relative flex w-full flex-col overflow-hidden rounded-[1.1rem] border border-border-weak-base bg-surface-raised-base text-left shadow-sm hover:-translate-y-0.5 hover:border-border-weak-hover hover:bg-surface-raised-base-hover hover:shadow-md active:scale-[0.985] cursor-pointer"
      draggable={true}
      onDragStart={(e) => attachNoteDragData(e, props.note)}
      onClick={props.onClick}
    >
      <Show when={props.originName}>
        <div class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha/90 px-2 py-1 text-text-weak shadow-sm backdrop-blur-sm">
          <Icon name="folder" class="size-2.5 text-text-weak" />
          <span class="text-10-medium leading-tight">{props.originName}</span>
        </div>
      </Show>
      <Show
        when={hasContent()}
        fallback={
          <div class="flex items-center justify-center py-6 text-text-weaker opacity-40">
            <Icon name="notebook-pen" size="large" />
          </div>
        }
      >
        <Show
          when={previewHtml()}
          fallback={
            <div class="px-3.5 py-3 text-11-regular leading-relaxed text-text-weak line-clamp-4 whitespace-pre-line">
              {searchPreview()}
            </div>
          }
        >
          <div
            class="note-preview-content px-3.5 py-3 text-11-regular leading-relaxed text-text-weak line-clamp-4"
            innerHTML={previewHtml()!}
          />
        </Show>
      </Show>

      <div class="mt-auto border-t border-border-weaker-base px-3.5 py-3">
        <div class="flex items-center gap-1.5">
          <Show when={props.note.pinned}>
            <span class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-raised-stronger-non-alpha text-text-interactive-base">
              <Icon name="pin" size="small" class="size-3" />
            </span>
          </Show>
          <span class="flex-1 line-clamp-1 text-12-medium leading-snug text-text-strong">
            {props.note.title || "Untitled"}
          </span>
        </div>
        <Show when={(props.note.tags ?? []).length > 0}>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <For each={(props.note.tags ?? []).slice(0, 3)}>
              {(tag) => (
                <span class="inline-flex items-center rounded-full bg-surface-raised-stronger-non-alpha/80 px-2 py-1 text-[10px] font-medium leading-none text-text-weak">
                  {tag}
                </span>
              )}
            </For>
            <Show when={(props.note.tags ?? []).length > 3}>
              <span class="text-10-medium text-text-weaker">+{(props.note.tags ?? []).length - 3}</span>
            </Show>
          </div>
        </Show>
        <span class="mt-2 block text-11-regular text-text-weak">{relativeTime(props.note.time.updated)}</span>
      </div>
    </button>
  )
}

/** Skeleton placeholder matching NoteCard shape, shown during list loading */
function NoteCardSkeleton() {
  return (
    <div class="flex w-full flex-col overflow-hidden rounded-[1.1rem] border border-border-weak-base bg-surface-raised-base shadow-sm animate-pulse">
      <div class="px-3.5 py-4 space-y-2">
        <div class="h-2.5 w-full rounded bg-surface-inset-base/70" />
        <div class="h-2.5 w-3/4 rounded bg-surface-inset-base/70" />
        <div class="h-2.5 w-1/2 rounded bg-surface-inset-base/70" />
      </div>
      <div class="mt-auto border-t border-border-weaker-base px-3.5 py-3">
        <div class="h-3 w-2/3 rounded bg-surface-inset-base/70" />
        <div class="mt-3 h-2.5 w-1/3 rounded bg-surface-inset-base/70" />
      </div>
    </div>
  )
}

function MiniNoteCard(props: { note: NoteMetaInfo; originName?: string; onClick: () => void }) {
  const tags = createMemo(() => props.note.tags ?? [])

  return (
    <button
      type="button"
      class="mini-note-card min-w-0 rounded-xl border border-border-weak-base bg-surface-raised-base px-3 py-2.5 text-left shadow-sm hover:-translate-y-0.5 hover:border-border-weak-hover hover:bg-surface-raised-base-hover hover:shadow-md active:scale-[0.985]"
      draggable={true}
      onDragStart={(e) => attachNoteDragData(e, props.note)}
      onClick={props.onClick}
    >
      <div class="flex min-w-0 items-center gap-1.5">
        <Show when={props.note.pinned}>
          <Icon name="pin" size="small" class="size-3 shrink-0 text-text-interactive-base" />
        </Show>
        <span class="min-w-0 flex-1 truncate text-11-medium leading-snug text-text-strong">
          {props.note.title || "Untitled"}
        </span>
      </div>
      <div class="mt-1.5 flex min-w-0 items-center gap-1.5 text-10-medium leading-none text-text-weaker">
        <Show when={props.originName}>
          <span class="inline-flex min-w-0 items-center gap-1 truncate text-text-weak">
            <Icon name="folder" class="size-2.5 shrink-0" />
            <span class="truncate">{props.originName}</span>
          </span>
        </Show>
        <Show when={tags()[0]}>
          <span class="max-w-[5.5rem] truncate rounded-md bg-surface-raised-stronger-non-alpha/72 px-1.5 py-0.5 text-text-weak">
            {tags()[0]}
          </span>
        </Show>
        <span class="shrink-0">{relativeTime(props.note.time.updated)}</span>
      </div>
    </button>
  )
}

type DisplayGroup = NoteMetaScopeGroup & {
  name: string
  directory: string
  isCurrent: boolean
}

function ScopeSection(props: {
  group: DisplayGroup
  expanded: boolean
  onToggle: () => void
  onOpenNote: (id: string) => void
  onCreateNote: () => void
  scopeLookup: Map<string, { name: string; directory: string }>
}) {
  const previewNotes = createMemo(() => props.group.notes.slice(0, 3))
  const latestUpdated = createMemo(() => props.group.notes[0]?.time.updated)
  const noteCountLabel = createMemo(
    () => `${props.group.notes.length} ${props.group.notes.length === 1 ? "note" : "notes"}`,
  )
  const sectionClass = createMemo(() => {
    if (props.expanded) return "border-border-weak-base bg-surface-inset-base/70"
    if (props.group.isCurrent) return "bg-surface-inset-base/42"
  })

  function getOriginName(note: NoteMetaInfo): string | undefined {
    if (props.group.scopeType !== "global") return undefined
    const origin = (note as any).originScope as string | undefined
    if (!origin) return undefined
    return props.scopeLookup.get(origin)?.name ?? origin
  }

  return (
    <section
      class={`relative mb-3 overflow-hidden rounded-[1.25rem] border border-border-weak-base bg-surface-inset-base/24 p-2 transition-colors hover:bg-surface-inset-base/34 ${sectionClass()}`}
    >
      <Show when={props.group.isCurrent}>
        <div class="absolute bottom-3 left-0 top-3 w-0.5 rounded-full bg-text-interactive-base/70" />
      </Show>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-surface-raised-base-hover/55"
          aria-expanded={props.expanded}
          aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.group.name} notes`}
          onClick={props.onToggle}
        >
          <span
            class="shrink-0 text-icon-weak transition-transform duration-150"
            classList={{ "rotate-90": props.expanded }}
          >
            <Icon name="chevron-right" size="small" />
          </span>
          <Show when={props.group.scopeType === "global"}>
            <Icon name="home" size="small" class="text-text-interactive-base shrink-0" />
          </Show>
          <Show when={props.group.scopeType === "project"}>
            <Icon name="folder" size="small" class="text-icon-weak shrink-0" />
          </Show>
          <span class="min-w-0 truncate text-12-medium text-text-strong">{props.group.name}</span>
          <Show when={props.group.isCurrent}>
            <span class="inline-flex items-center gap-1 rounded-full bg-surface-raised-stronger-non-alpha/85 px-2 py-0.5 text-[10px] font-medium text-text-interactive-base ring-1 ring-inset ring-border-weaker-base">
              <span class="size-1.5 rounded-full bg-text-interactive-base/80" />
              Current
            </span>
          </Show>
          <span class="flex-1" />
          <span class="shrink-0 text-11-regular text-text-weaker">{noteCountLabel()}</span>
          <Show when={latestUpdated()}>
            <span class="hidden shrink-0 text-11-regular text-text-weaker sm:inline">
              · {relativeTime(latestUpdated()!)}
            </span>
          </Show>
        </button>
        <button
          type="button"
          class="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha text-icon-weak opacity-70 shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-icon-base hover:opacity-100"
          onClick={props.onCreateNote}
          title="New note"
        >
          <Icon name="plus" size="small" />
        </button>
      </div>

      <Show
        when={props.expanded}
        fallback={
          <Show when={previewNotes().length > 0}>
            <div class="flex flex-col gap-2 px-1 pb-1 pt-1.5">
              <For each={previewNotes()}>
                {(note) => (
                  <MiniNoteCard
                    note={note}
                    originName={getOriginName(note)}
                    onClick={() => props.onOpenNote(note.id)}
                  />
                )}
              </For>
            </div>
          </Show>
        }
      >
        <Show
          when={props.group.notes.length > 0}
          fallback={<div class="py-4 text-center text-12-regular text-text-weaker">No notes in this scope</div>}
        >
          <div
            class="mt-2 grid gap-2.5 px-1 mb-1"
            style="grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr))"
          >
            <For each={props.group.notes}>
              {(note) => (
                <NoteCard note={note} originName={getOriginName(note)} onClick={() => props.onOpenNote(note.id)} />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  )
}

export function NotePanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  const [view, setView] = createSignal<"list" | "editor">("list")
  const [selectedNoteId, setSelectedNoteId] = createSignal<string | null>(null)
  const [selectedNoteDir, setSelectedNoteDir] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal("")
  const [selectedTags, setSelectedTags] = createSignal<Set<string>>(new Set())
  const [expandedState, setExpandedState] = createSignal<Record<string, boolean>>({})

  const currentScopeID = createMemo(() => {
    const dir = directory()
    if (!dir || dir === "global") return "global"
    const scope = globalSync.data.scope.find((s) => s.worktree === dir || (s.sandboxes ?? []).includes(dir))
    return scope?.id ?? ""
  })

  const scopeLookup = createMemo(() => {
    const map = new Map<string, { name: string; directory: string }>()
    map.set("global", { name: getScopeLabel(undefined, "global"), directory: "global" })
    for (const scope of globalSync.data.scope) {
      map.set(scope.id, {
        name: getScopeLabel(scope),
        directory: scope.worktree,
      })
    }
    return map
  })

  const [rawGroups, { refetch }] = createResource(
    () => ({ dir: directory(), ver: globalSync.noteVersion() }),
    async ({ dir }) => {
      if (!dir) return []
      const result = await sdk.client.note.listMeta({ directory: dir })
      return (result.data ?? []) as NoteMetaScopeGroup[]
    },
  )

  const allTags = createMemo(() => {
    const freq = new Map<string, number>()
    for (const g of rawGroups() ?? []) {
      for (const n of g.notes) {
        for (const t of n.tags ?? []) {
          freq.set(t, (freq.get(t) ?? 0) + 1)
        }
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
  })

  function toggleTag(tag: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  const displayGroups = createMemo(() => {
    const groups = rawGroups() ?? []
    const lookup = scopeLookup()
    const curID = currentScopeID()
    const q = search().toLowerCase().trim()
    const activeTags = selectedTags()

    return groups
      .map((g): DisplayGroup => {
        const meta = lookup.get(g.scopeID)
        const isCurrent = g.scopeID === curID
        let notes = [...g.notes]
        if (q) {
          notes = notes.filter((n) => {
            if (n.title.toLowerCase().includes(q)) return true
            const searchText = n.searchText ?? ""
            return searchText.toLowerCase().includes(q)
          })
        }
        if (activeTags.size > 0) {
          notes = notes.filter((n) => (n.tags ?? []).some((t) => activeTags.has(t)))
        }
        notes.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.time.updated - a.time.updated
        })
        return {
          ...g,
          notes,
          name: meta?.name ?? g.scopeID,
          directory: meta?.directory ?? "global",
          isCurrent,
        }
      })
      .filter((g) => {
        const hasFilters = q || activeTags.size > 0
        return hasFilters ? g.notes.length > 0 : g.notes.length > 0 || g.isCurrent
      })
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        const latestA = a.notes[0]?.time.updated ?? 0
        const latestB = b.notes[0]?.time.updated ?? 0
        return latestB - latestA
      })
  })

  const totalNotes = createMemo(() => (rawGroups() ?? []).reduce((sum, g) => sum + g.notes.length, 0))

  function isExpanded(scopeID: string, isCurrent: boolean) {
    const state = expandedState()[scopeID]
    if (state !== undefined) return state
    return isCurrent
  }

  function toggleExpanded(scopeID: string, isCurrent: boolean) {
    setExpandedState((prev) => ({ ...prev, [scopeID]: !isExpanded(scopeID, isCurrent) }))
  }

  function openNote(id: string, dir: string) {
    setSelectedNoteId(id)
    setSelectedNoteDir(dir)
    setView("editor")
  }

  async function createNoteInScope(dir: string) {
    try {
      const result = await sdk.client.note.create({
        directory: dir,
        noteCreateInput: { title: "" },
      })
      if (result.data) {
        await refetch()
        openNote(result.data.id, dir)
      }
    } catch (e) {
      console.error("Failed to create note", e)
    }
  }

  return (
    <div class="flex flex-col h-full bg-background-base relative">
      <style>{TIPTAP_STYLES}</style>

      <Show when={view() === "list"}>
        <div class="flex flex-col h-full">
          <div class="shrink-0 px-4 pt-3 pb-2">
            <div class="flex items-center gap-2.5 rounded-xl bg-surface-inset-base/60 px-3.5 py-2.5 transition-colors">
              <Icon name="search" size="small" class="text-icon-weak shrink-0" />
              <input
                type="text"
                placeholder="Search notes..."
                class="flex-1 bg-transparent text-13-regular text-text-base placeholder:text-text-weak outline-none"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
              <Show when={search()}>
                <button
                  type="button"
                  class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base transition-colors"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                >
                  <Icon name="x" size="small" />
                </button>
              </Show>
              <span class="text-11-regular text-text-weak mr-0.5">{totalNotes()}</span>
              <button
                type="button"
                class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                onClick={() => refetch()}
                title="Refresh"
              >
                <Icon name="refresh-ccw" size="small" />
              </button>
            </div>

            <Show when={allTags().length > 0}>
              <div class="notes-tag-bar mt-2 flex items-center gap-1.5 overflow-x-auto">
                <Show when={selectedTags().size > 0}>
                  <button
                    type="button"
                    class="shrink-0 flex items-center justify-center size-6 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                    onClick={() => setSelectedTags(new Set())}
                    aria-label="Clear all filters"
                  >
                    <Icon name="x" size="small" />
                  </button>
                </Show>
                <For each={allTags()}>
                  {({ tag, count }) => (
                    <button
                      type="button"
                      classList={{
                        "px-2.5 py-1 rounded-lg text-12-medium transition-colors": true,
                        "bg-surface-raised-base-hover text-text-strong": selectedTags().has(tag),
                        "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover":
                          !selectedTags().has(tag),
                      }}
                      onClick={() => toggleTag(tag)}
                    >
                      <span class="whitespace-nowrap">
                        {tag}
                        <span class="ml-0.5 opacity-60">{count}</span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <Show when={rawGroups.loading}>
              <div
                class="grid gap-3 py-4"
                style="grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr))"
              >
                <NoteCardSkeleton />
                <NoteCardSkeleton />
                <NoteCardSkeleton />
                <NoteCardSkeleton />
                <NoteCardSkeleton />
                <NoteCardSkeleton />
              </div>
            </Show>
            <Show when={!rawGroups.loading}>
              <Show
                when={displayGroups().length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center py-16 gap-3">
                    <Icon name="notebook-pen" size="large" class="text-icon-weak" />
                    <div class="text-14-medium text-text-weak">No notes found</div>
                  </div>
                }
              >
                <div class="flex flex-col gap-1">
                  <For each={displayGroups()}>
                    {(group) => (
                      <ScopeSection
                        group={group}
                        expanded={isExpanded(group.scopeID, group.isCurrent)}
                        onToggle={() => toggleExpanded(group.scopeID, group.isCurrent)}
                        onOpenNote={(id) => openNote(id, group.directory)}
                        onCreateNote={() => createNoteInScope(group.directory)}
                        scopeLookup={scopeLookup()}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={view() === "editor" && selectedNoteId()}>
        <NoteEditor
          id={selectedNoteId()!}
          directory={selectedNoteDir() ?? directory() ?? "global"}
          onBack={() => {
            setView("list")
            refetch()
          }}
          onDelete={() => {
            setView("list")
            refetch()
          }}
        />
      </Show>
    </div>
  )
}

type NoteConflictState =
  | {
      type: "remote-update"
      message: string
      remote: NoteInfo
    }
  | {
      type: "metadata-blocked"
      message: string
    }

function NoteEditor(props: { id: string; directory: string; onBack: () => void; onDelete: () => void }) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const directory = () => props.directory

  const [note, { refetch }] = createResource(
    () => ({ id: props.id, dir: directory() }),
    async ({ id, dir }) => {
      if (!dir) return null
      const result = await sdk.client.note.get({ id, directory: dir })
      return result.data as NoteInfo
    },
  )

  // Re-fetch this note only when it was updated by another session/tab
  createEffect(() => {
    const update = globalSync.noteUpdate()
    if (!update) return
    if (update.id !== props.id) return
    if (update.type === "deleted") return
    const base = baseNote()
    // No base note yet = initial load handled by the resource itself
    if (!base) return
    // Our own save already set baseNote to the latest version — skip echo
    if (update.version <= base.version) return
    void refetch()
  })

  const [baseNote, setBaseNote] = createSignal<NoteInfo | null>(null)
  const [title, setTitle] = createSignal("")
  const [tags, setTags] = createSignal<string[]>([])
  const [tagInput, setTagInput] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [conflict, setConflict] = createSignal<NoteConflictState | null>(null)
  const [editor, setEditor] = createSignal<Editor>()

  let editorRef!: HTMLDivElement
  let bubbleRef!: HTMLDivElement
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let saveQueued = false
  let saveInFlight: Promise<void> | undefined

  const noteLoaded = createMemo(() => !!baseNote())

  function remoteConflict() {
    const current = conflict()
    if (current?.type !== "remote-update") return null
    return current.remote
  }

  function markDirty() {
    setDirty(true)
    if (!remoteConflict()) setConflict(null)
  }

  function clearDebounce() {
    if (!debounceTimer) return
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }

  function applySnapshot(snapshot: NoteInfo) {
    const ed = editor()
    setBaseNote(snapshot)
    setTitle(snapshot.title)
    setTags(snapshot.tags ?? [])
    setConflict(null)
    setDirty(false)
    if (ed && !ed.isDestroyed) {
      const scrollTop = editorRef?.scrollTop ?? 0
      const { from } = ed.state.selection
      ed.commands.setContent(snapshot.content as any, { emitUpdate: false })
      const docSize = ed.state.doc.content.size
      if (from > 0 && from < docSize) {
        try {
          ed.commands.setTextSelection(from)
        } catch {
          /* position may be invalid */
        }
      }
      if (editorRef) editorRef.scrollTop = scrollTop
    }
  }

  function currentDraft() {
    const ed = editor()
    if (!ed || ed.isDestroyed) return null
    const content = ed.getJSON()
    return {
      title: title(),
      tags: tags(),
      content,
    }
  }

  function parseConflict(error: unknown) {
    if (!(error instanceof Error) || error.name !== "APIError") return null
    const data = (error as { data?: { statusCode?: number; responseBody?: string } }).data
    if (data?.statusCode !== 409 || !data.responseBody) return null
    try {
      const parsed = JSON.parse(data.responseBody) as {
        name?: string
        data?: { note?: NoteInfo }
      }
      if (parsed.name !== "NoteConflictError" || !parsed.data?.note) return null
      return parsed.data.note
    } catch {
      return null
    }
  }

  async function runSave() {
    const dir = directory()
    const base = baseNote()
    const draft = currentDraft()
    if (!dir || !base || !draft || !dirty() || remoteConflict()) return

    setSaving(true)
    try {
      const result = await sdk.client.note.update({
        id: props.id,
        directory: dir,
        notePatchInput: {
          title: draft.title,
          content: draft.content,
          tags: draft.tags,
          expectedVersion: base.version,
        },
      })
      const saved = result.data as NoteInfo
      setBaseNote(saved)
      setTags(saved.tags ?? [])
      setConflict(null)
      setDirty(false)
    } catch (error) {
      const remote = parseConflict(error)
      if (remote) {
        setConflict({
          type: "remote-update",
          message: "This note was updated elsewhere. Review the remote version or overwrite it with your draft.",
          remote,
        })
        return
      }
      console.error("Failed to save note", error)
    } finally {
      setSaving(false)
    }
  }

  async function drainSaveQueue() {
    if (saveInFlight) {
      saveQueued = true
      return saveInFlight
    }
    saveInFlight = (async () => {
      do {
        saveQueued = false
        await runSave()
      } while (saveQueued)
    })().finally(() => {
      saveInFlight = undefined
    })
    return saveInFlight
  }

  function scheduleSave() {
    clearDebounce()
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void drainSaveQueue()
    }, 1000)
  }

  async function flushSave() {
    clearDebounce()
    if (!dirty()) return
    await drainSaveQueue()
  }

  createEffect(() => {
    const incoming = note()
    if (!incoming) return
    const current = baseNote()
    if (!current) {
      applySnapshot(incoming)
      return
    }
    if (incoming.version <= current.version) return
    if (!dirty()) {
      applySnapshot(incoming)
      return
    }
    setConflict({
      type: "remote-update",
      message: "This note was updated elsewhere while you were editing.",
      remote: incoming,
    })
  })

  onCleanup(() => {
    clearDebounce()
  })

  async function handleBack() {
    await flushSave()
    if (remoteConflict()) return
    props.onBack()
  }

  async function saveMetadata(patch: { pinned?: boolean; global?: boolean }) {
    const dir = directory()
    const base = baseNote()
    if (!dir || !base) return false
    setSaving(true)
    try {
      const result = await sdk.client.note.update({
        id: props.id,
        directory: dir,
        notePatchInput: {
          pinned: patch.pinned,
          global: patch.global,
          expectedVersion: base.version,
        },
      })
      applySnapshot(result.data as NoteInfo)
      return true
    } catch (error) {
      const remote = parseConflict(error)
      if (remote) {
        setConflict({
          type: "remote-update",
          message: "This note changed before your metadata update could be saved.",
          remote,
        })
        return false
      }
      console.error("Failed to save note metadata", error)
      return false
    } finally {
      setSaving(false)
    }
  }

  function addTag(tag: string) {
    const t = tag.trim().toLowerCase()
    if (!t || tags().includes(t)) return
    setTags([...tags(), t])
    markDirty()
    scheduleSave()
    setTagInput("")
  }

  function removeTag(tag: string) {
    setTags(tags().filter((t) => t !== tag))
    markDirty()
    scheduleSave()
  }

  function handleTagKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      addTag(tagInput())
    }
    if (e.key === "Backspace" && !tagInput() && tags().length > 0) {
      removeTag(tags()[tags().length - 1])
    }
  }

  async function uploadFile(file: File): Promise<string> {
    const res = await sdk.client.asset.upload({ file })
    return assetHttpUrl(sdk.url, res.data as { id?: string; url?: string } | undefined)
  }

  createEffect(() => {
    const loaded = noteLoaded()
    if (!loaded || untrack(() => editor())) return
    untrack(() => {
      const snapshot = baseNote()!
      const instance = new Editor({
        element: editorRef,
        extensions: [
          StarterKit.configure({
            codeBlock: false,
            link: false,
          }),
          Placeholder.configure({
            placeholder: "Type / for commands...",
          }),
          Link.configure({
            openOnClick: false,
            autolink: true,
          }),
          Image,
          Table.configure({
            resizable: true,
          }),
          TableRow,
          TableHeader,
          TableCell,
          CrossCellSelection,
          TaskList,
          TaskItem.configure({
            nested: true,
          }),
          CodeBlockShiki.configure({
            defaultTheme: "github-dark",
          }),
          MathExtension,
          Video,
          Mermaid,
          createFileUpload(sdk.client, sdk.url),
          createSlashCommands({ onUploadFile: uploadFile }),
          createBubbleMenu(bubbleRef),
        ],
        content: snapshot.content as any,
        onUpdate: ({ editor }) => {
          if (editor.isDestroyed) return
          markDirty()
          scheduleSave()
        },
      })

      onCleanup(() => instance.destroy())
      setEditor(instance)
    })
  })

  function handleEditorAreaClick(e: MouseEvent) {
    const ed = editor()
    if (!ed || ed.isDestroyed || ed.isFocused) return
    const target = e.target as HTMLElement
    if (target === editorRef) {
      ed.commands.focus()
      return
    }
    if (!target.classList.contains("tiptap")) return
    const pos = ed.view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (pos) {
      ed.commands.focus()
      ed.commands.setTextSelection(pos.pos)
    }
  }

  function onTitleInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    setTitle(e.currentTarget.value)
    markDirty()
    scheduleSave()
  }

  async function togglePin() {
    const current = baseNote()
    if (!current) return
    if (dirty()) {
      setConflict({
        type: "metadata-blocked",
        message: "Save or reload your draft before changing note metadata.",
      })
      return
    }
    await saveMetadata({ pinned: !current.pinned })
  }

  async function toggleGlobal() {
    const current = baseNote()
    if (!current) return
    if (dirty()) {
      setConflict({
        type: "metadata-blocked",
        message: "Save or reload your draft before changing note metadata.",
      })
      return
    }
    await saveMetadata({ global: !current.global })
  }

  function reloadRemote() {
    const remote = remoteConflict()
    if (!remote) return
    applySnapshot(remote)
  }

  async function overwriteRemote() {
    const remote = remoteConflict()
    if (!remote) return
    setBaseNote(remote)
    setConflict(null)
    await drainSaveQueue()
  }

  function downloadNote() {
    const dir = directory()
    if (!dir) return
    const params = new URLSearchParams({ directory: dir, format: "md" })
    const url = `${sdk.url}/note/export/${encodeURIComponent(props.id)}?${params}`
    const a = document.createElement("a")
    a.href = url
    a.download = ""
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  async function deleteNote() {
    const dir = directory()
    if (!dir) return
    if (!confirm("Are you sure you want to delete this note?")) return
    await sdk.client.note.remove({ id: props.id, directory: dir })
    props.onDelete()
  }

  return (
    <div class="flex flex-col h-full bg-background-base">
      <Show when={note.loading && !noteLoaded()}>
        <div class="flex items-center justify-center h-full">
          <Spinner class="size-6" />
        </div>
      </Show>

      <Show when={noteLoaded() && baseNote()}>
        <div class="shrink-0 border-b border-border-weak-base bg-surface-raised-base/92 px-4 py-3">
          <div class="flex items-center gap-2 rounded-[1.15rem] bg-surface-inset-base/42 px-2.5 py-2">
            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha text-icon-weak shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
              onClick={handleBack}
              title="Back to list"
            >
              <Icon name="arrow-left" size="normal" />
            </button>

            <div class="min-w-0 flex-1 rounded-[0.95rem] bg-surface-raised-base/92 px-3.5 py-2">
              <input
                type="text"
                class="w-full bg-transparent text-14-medium tracking-tight text-text-strong outline-none placeholder:text-text-weak/50"
                placeholder="Untitled"
                value={title()}
                onInput={onTitleInput}
              />
            </div>

            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-11-medium transition-all"
              classList={{
                "bg-surface-interactive-base/14 text-text-interactive-base shadow-sm": baseNote()!.pinned,
                "bg-surface-raised-stronger-non-alpha text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base":
                  !baseNote()!.pinned,
              }}
              onClick={togglePin}
            >
              <Icon name="pin" size="small" />
              <span>{baseNote()!.pinned ? "Pinned" : "Pin"}</span>
            </button>

            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-11-medium transition-all"
              classList={{
                "bg-surface-diff-add-base/12 text-text-diff-add-base shadow-sm": baseNote()!.global,
                "bg-surface-raised-stronger-non-alpha text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base":
                  !baseNote()!.global,
              }}
              onClick={toggleGlobal}
            >
              <Icon name="globe" size="small" />
              <span>{baseNote()!.global ? "Global" : "Local"}</span>
            </button>

            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha text-icon-weak shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
              onClick={downloadNote}
              title="Download as Markdown"
            >
              <Icon name="download" size="small" />
            </button>

            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha text-icon-weak shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base"
              onClick={deleteNote}
              title="Delete"
            >
              <Icon name="trash-2" size="small" />
            </button>
          </div>
        </div>

        <Show when={conflict()}>
          <div class="shrink-0 border-b border-border-warning-base bg-surface-raised-base px-4 py-3 text-12-regular text-text-base">
            <div class="flex flex-wrap items-center gap-2 rounded-[1rem] bg-background-base/55 px-3 py-2.5 backdrop-blur-sm">
              <div class="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-warning-base/18 text-icon-warning-base">
                <div class="size-1.5 rounded-full bg-icon-warning-base" />
              </div>
              <span class="flex-1 text-11-regular leading-5 text-text-base">{conflict()!.message}</span>
              <Show when={conflict()?.type === "remote-update"}>
                <button
                  type="button"
                  class="rounded-full bg-surface-raised-stronger-non-alpha px-3 py-1.5 text-11-medium text-text-base transition-colors hover:bg-surface-raised-base-hover"
                  onClick={reloadRemote}
                >
                  Reload remote
                </button>
                <button
                  type="button"
                  class="rounded-full bg-surface-interactive-base/12 px-3 py-1.5 text-11-medium text-text-interactive-base transition-colors hover:bg-surface-interactive-base/18"
                  onClick={overwriteRemote}
                >
                  Overwrite remote
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <div class="shrink-0 border-b border-border-weak-base bg-surface-raised-base/88 px-4 py-3">
          <div class="flex flex-wrap items-center gap-2 rounded-[1rem] bg-surface-inset-base/42 px-3 py-2.5">
            <For each={tags()}>
              {(tag) => (
                <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-raised-stronger-non-alpha px-2.5 py-1.5 text-11-medium text-text-weak">
                  <button
                    type="button"
                    class="flex size-4 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-icon-base"
                    onClick={() => removeTag(tag)}
                  >
                    <Icon name="x" size="small" class="size-2.5" />
                  </button>
                  {tag}
                </span>
              )}
            </For>
            <div class="flex min-w-[7rem] flex-1 items-center gap-2 rounded-full bg-surface-raised-base/92 px-3 py-1.5">
              <Icon name="tag" size="small" class="text-icon-weak shrink-0" />
              <input
                type="text"
                class="min-w-0 flex-1 bg-transparent text-11-regular text-text-base outline-none placeholder:text-text-weaker"
                placeholder={tags().length === 0 ? "Add tags..." : "Add tag"}
                value={tagInput()}
                onInput={(e) => setTagInput(e.currentTarget.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={() => {
                  if (tagInput().trim()) addTag(tagInput())
                }}
              />
            </div>
          </div>
        </div>

        <div class="relative flex-1 min-h-0 bg-background-base px-4 pb-4 pt-3">
          <div class="relative h-full overflow-hidden rounded-[1.25rem] border border-border-weak-base bg-surface-raised-base">
            <div
              ref={editorRef}
              class="h-full overflow-y-auto px-6 py-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onClick={handleEditorAreaClick}
            />
            <div
              class="pointer-events-none absolute inset-x-0 bottom-0 h-14"
              style={{ background: "linear-gradient(to top, var(--surface-raised-base), transparent)" }}
            />
          </div>
          <div ref={bubbleRef} class="note-bubble-menu">
            <Show when={editor()}>
              <BubbleMenuContent editor={editor()!} />
            </Show>
          </div>
          <div class="pointer-events-none absolute bottom-7 right-7 inline-flex items-center rounded-full bg-background-base/72 px-3 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-weak-base backdrop-blur-sm">
            <Show when={saving()} fallback="Saved">
              Saving...
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

const TIPTAP_STYLES = `
  .tiptap {
    outline: none;
    min-height: 100%;
    font-family: ui-sans-serif, system-ui, sans-serif;
    color: var(--text-base);
  }
  .tiptap::after {
    content: '';
    display: block;
    height: 50vh;
  }
  .tiptap p {
    margin-bottom: 0.75em;
    line-height: 1.6;
    font-size: 0.9375rem;
    color: var(--text-base);
  }
  .tiptap h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    color: var(--text-strong);
  }
  .tiptap h2 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-top: 1.25em;
    margin-bottom: 0.5em;
    color: var(--text-strong);
  }
  .tiptap h3 {
    font-size: 1.125rem;
    font-weight: 600;
    margin-top: 1em;
    margin-bottom: 0.5em;
    color: var(--text-strong);
  }
  .tiptap ul, .tiptap ol {
    padding-left: 1.5em;
    margin-bottom: 0.75em;
    color: var(--text-base);
  }
  .tiptap ul { list-style-type: disc; }
  .tiptap ol { list-style-type: decimal; }
  .tiptap blockquote {
    margin-left: 0;
    margin-right: 0;
    margin-bottom: 0.95em;
    border-left: 3px solid color-mix(in srgb, var(--border-strong-base) 78%, var(--surface-brand-base));
    border-radius: 0 0.9rem 0.9rem 0;
    background: color-mix(in srgb, var(--surface-inset-base) 74%, transparent);
    padding: 0.9em 1.05em;
    font-style: italic;
    color: var(--text-weak);
    box-shadow: inset 0 1px 0 rgba(0,0,0,0.04);
  }
  .tiptap pre {
    background: var(--surface-inset-base);
    border: 1px solid color-mix(in srgb, var(--border-base) 72%, transparent);
    border-radius: 0.95rem;
    padding: 1em 1.05em;
    overflow-x: auto;
    margin-bottom: 0.95em;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 14px 34px -28px rgba(0,0,0,0.28);
  }
  .tiptap pre code {
    background: none;
    padding: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.875rem;
    color: color-mix(in srgb, var(--text-strong) 82%, white 18%);
  }
  .tiptap code {
    background: color-mix(in srgb, var(--surface-inset-base) 78%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-base) 58%, transparent);
    padding: 0.18em 0.45em;
    border-radius: 0.45rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.85em;
    color: var(--text-strong);
    box-shadow: inset 0 1px 0 rgba(0,0,0,0.04);
  }
  .tiptap table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 0.95em;
    overflow: hidden;
    border-radius: 0.95rem;
  }
  .tiptap td, .tiptap th {
    border: 1px solid color-mix(in srgb, var(--border-weak-base) 82%, transparent);
    padding: 0.6em 0.7em;
    text-align: left;
  }
  .tiptap th {
    background: color-mix(in srgb, var(--surface-inset-base) 72%, transparent);
    font-weight: 600;
  }
  .tiptap p.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    float: left;
    color: var(--text-weaker);
    pointer-events: none;
    height: 0;
  }
  .tiptap ul[data-type="taskList"] {
    list-style: none;
    padding: 0;
  }
  .tiptap ul[data-type="taskList"] li {
    display: flex;
    gap: 0.5em;
    align-items: flex-start;
  }
  .tiptap ul[data-type="taskList"] li input[type="checkbox"] {
    margin-top: 0.3em;
  }
  .tiptap a {
    color: var(--text-interactive-base);
    text-decoration: none;
    text-decoration-color: color-mix(in srgb, var(--text-interactive-base) 38%, transparent);
  }
  .tiptap a:hover {
    text-decoration: underline;
  }
  .katex-display {
    margin: 0.5em 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .tiptap video {
    max-width: 100%;
    border-radius: 0.5rem;
    margin-bottom: 0.75em;
  }
  .tiptap .mermaid-node {
    margin-bottom: 0.75em;
  }
  .note-bubble-menu {
    z-index: 100;
  }
  .note-preview-content p,
  .note-preview-content ul,
  .note-preview-content ol,
  .note-preview-content blockquote,
  .note-preview-content pre {
    margin-bottom: 0.4em;
  }
  .note-preview-content ul,
  .note-preview-content ol {
    padding-left: 1.2em;
  }
  .note-preview-content ul { list-style-type: disc; }
  .note-preview-content ol { list-style-type: decimal; }
  .note-preview-content h1,
  .note-preview-content h2,
  .note-preview-content h3 {
    font-weight: 600;
    margin-bottom: 0.3em;
    color: var(--text-base);
  }
  .note-preview-content h1 { font-size: 1rem; }
  .note-preview-content h2 { font-size: 0.9375rem; }
  .note-preview-content h3 { font-size: 0.875rem; }
  .note-preview-content code {
    background: color-mix(in srgb, var(--surface-inset-base) 78%, transparent);
    border-radius: 0.3rem;
    padding: 0.05em 0.3em;
    font-size: 0.85em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .note-preview-content pre {
    background: var(--surface-inset-base);
    border-radius: 0.5rem;
    padding: 0.5em 0.65em;
    overflow-x: auto;
    font-size: 0.8em;
  }
  .note-preview-content pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }
  .note-preview-content blockquote {
    border-left: 2px solid color-mix(in srgb, var(--border-weak-base) 80%, transparent);
    padding-left: 0.6em;
    color: var(--text-weaker);
  }
  .note-preview-content .note-preview-task-list {
    list-style: none;
    padding-left: 0;
  }
  .note-preview-content .note-preview-task-list li {
    display: flex;
    gap: 0.4em;
    align-items: flex-start;
  }
  .note-preview-content .note-preview-task-list input[type="checkbox"] {
    margin-top: 0.2em;
  }
  .note-preview-content strong {
    font-weight: 600;
  }
  .note-preview-content em {
    font-style: italic;
  }
  .note-preview-content s {
    text-decoration: line-through;
  }
`
