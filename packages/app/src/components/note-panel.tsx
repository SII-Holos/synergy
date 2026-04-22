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
import { Panel } from "@/components/panel"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { NoteMarkdown } from "@ericsanchezok/synergy-util/note-markdown"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { Video, Mermaid, CrossCellSelection, createFileUpload } from "@/components/note/extensions"
import { createSlashCommands } from "@/components/note/slash-menu"
import { createBubbleMenu, BubbleMenuContent } from "@/components/note/bubble-menu"
import type { NoteInfo, NoteScopeGroup } from "@ericsanchezok/synergy-sdk/client"
import { getScopeLabel } from "@/utils/scope"
import { relativeTime } from "@/utils/time"
import "katex/dist/katex.min.css"

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function tiptapToHtml(node: any): string {
  if (!node) return ""
  if (node.type === "text") {
    let html = escapeHtml(node.text || "")
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case "bold":
          html = `<strong>${html}</strong>`
          break
        case "italic":
          html = `<em>${html}</em>`
          break
        case "code":
          html = `<code>${html}</code>`
          break
        case "strike":
          html = `<s>${html}</s>`
          break
        case "link":
          html = `<a href="${escapeHtml(mark.attrs?.href ?? "")}">${html}</a>`
          break
      }
    }
    return html
  }
  const children = (node.content ?? []).map(tiptapToHtml).join("")
  switch (node.type) {
    case "doc":
      return children
    case "paragraph":
      return `<p>${children || "<br>"}</p>`
    case "heading":
      return `<h${node.attrs?.level ?? 1}>${children}</h${node.attrs?.level ?? 1}>`
    case "bulletList":
      return `<ul>${children}</ul>`
    case "orderedList":
      return `<ol>${children}</ol>`
    case "listItem":
      return `<li>${children}</li>`
    case "blockquote":
      return `<blockquote>${children}</blockquote>`
    case "codeBlock":
      return `<pre><code>${children}</code></pre>`
    case "image":
      return `<img src="${escapeHtml(node.attrs?.src ?? "")}" alt="${escapeHtml(node.attrs?.alt ?? "")}" style="max-width:100%;border-radius:0.375rem" />`
    case "horizontalRule":
      return `<hr />`
    case "hardBreak":
      return `<br />`
    case "taskList":
      return `<ul data-type="taskList">${children}</ul>`
    case "taskItem": {
      const checked = node.attrs?.checked ? " checked" : ""
      return `<li><input type="checkbox"${checked} disabled />${children}</li>`
    }
    case "table":
      return `<table>${children}</table>`
    case "tableRow":
      return `<tr>${children}</tr>`
    case "tableHeader":
      return `<th>${children}</th>`
    case "tableCell":
      return `<td>${children}</td>`
    case "video":
      return `<div style="background:var(--surface-inset-base);border-radius:0.375rem;padding:1em;text-align:center;color:var(--text-weak);font-size:0.75rem">▶ Video</div>`
    default:
      return children
  }
}

function NoteCard(props: { note: NoteInfo; originName?: string; onClick: () => void }) {
  const previewHtml = createMemo(() => tiptapToHtml(props.note.content))
  const hasContent = createMemo(() => {
    const html = previewHtml()
    return html.length > 0 && html !== "<p><br></p>"
  })

  const handleDragStart = (e: DragEvent) => {
    const payload = JSON.stringify({
      id: props.note.id,
      title: props.note.title,
      content: NoteMarkdown.toMarkdown(props.note.content),
    })
    e.dataTransfer!.effectAllowed = "copy"
    e.dataTransfer!.setData("application/x-synergy-note", payload)
    e.dataTransfer!.setData("text/plain", props.note.title || "Untitled")

    const dragImage = document.createElement("div")
    dragImage.className =
      "flex items-center gap-2 px-2.5 py-1.5 bg-surface-raised-base rounded-lg border border-border-base text-12-medium text-text-base"
    dragImage.style.position = "absolute"
    dragImage.style.top = "-1000px"
    dragImage.textContent = props.note.title || "Untitled"
    document.body.appendChild(dragImage)
    e.dataTransfer!.setDragImage(dragImage, 0, 16)
    setTimeout(() => document.body.removeChild(dragImage), 0)
  }

  return (
    <button
      type="button"
      class="relative w-full rounded-xl bg-surface-raised-base border border-border-base/30 overflow-hidden text-left transition-all hover:bg-surface-raised-base-hover hover:border-border-base/50 active:scale-[0.98] cursor-pointer group flex flex-col"
      draggable={true}
      onDragStart={handleDragStart}
      onClick={props.onClick}
    >
      <Show when={props.originName}>
        <div class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-raised-stronger-non-alpha/90 backdrop-blur-sm border border-border-base/30 shadow-sm">
          <Icon name="folder" class="size-2.5 text-text-weak" />
          <span class="text-10-regular text-text-weak leading-tight">{props.originName}</span>
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
        <div class="relative overflow-hidden w-full" style={{ "max-height": "220px", "min-height": "60px" }}>
          <div
            class="tiptap pointer-events-none select-none"
            style={{ zoom: "0.34", padding: "0.75rem 0.875rem", "min-height": `${60 / 0.34}px` }}
            innerHTML={previewHtml()}
          />
          <div
            class="absolute bottom-0 inset-x-0 h-8 pointer-events-none"
            style={{ background: "linear-gradient(to top, var(--surface-raised-base), transparent)" }}
          />
        </div>
      </Show>

      <div class="px-3 py-2 border-t border-border-base/20 mt-auto">
        <div class="flex items-center gap-1.5">
          <Show when={props.note.pinned}>
            <Icon name="pin" size="small" class="text-text-interactive-base shrink-0" />
          </Show>
          <span class="text-12-medium text-text-strong line-clamp-1 leading-snug flex-1">
            {props.note.title || "Untitled"}
          </span>
        </div>
        <Show when={(props.note.tags ?? []).length > 0}>
          <div class="flex items-center gap-1 mt-1 flex-wrap">
            <For each={(props.note.tags ?? []).slice(0, 3)}>
              {(tag) => (
                <span class="inline-block px-1.5 py-px rounded bg-surface-interactive-base/10 text-10-regular text-text-interactive-base leading-tight">
                  {tag}
                </span>
              )}
            </For>
            <Show when={(props.note.tags ?? []).length > 3}>
              <span class="text-10-regular text-text-weaker">+{(props.note.tags ?? []).length - 3}</span>
            </Show>
          </div>
        </Show>
        <span class="text-11-regular text-text-weak">{relativeTime(props.note.time.updated)}</span>
      </div>
    </button>
  )
}

type DisplayGroup = NoteScopeGroup & {
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
  function getOriginName(note: NoteInfo): string | undefined {
    if (props.group.scopeType !== "global") return undefined
    const origin = (note as any).originScope as string | undefined
    if (!origin) return undefined
    return props.scopeLookup.get(origin)?.name ?? origin
  }
  return (
    <div class="mb-1">
      <div
        role="button"
        tabIndex={0}
        class="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg hover:bg-surface-raised-base-hover transition-colors group/scope cursor-pointer"
        onClick={props.onToggle}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") props.onToggle()
        }}
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
        <span class="text-12-medium text-text-base text-left truncate">{props.group.name}</span>
        <Show when={props.group.isCurrent}>
          <span class="text-10-regular text-text-interactive-base opacity-60">·</span>
          <span class="text-10-regular text-text-interactive-base">Current</span>
        </Show>
        <span class="flex-1" />
        <span class="text-11-regular text-text-weaker">{props.group.notes.length}</span>
        <button
          type="button"
          class="flex items-center justify-center size-6 rounded-md text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-active opacity-0 group-hover/scope:opacity-100 transition-all"
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            props.onCreateNote()
          }}
          title="New note"
        >
          <Icon name="plus" size="small" />
        </button>
      </div>

      <Show when={props.expanded}>
        <Show
          when={props.group.notes.length > 0}
          fallback={<div class="text-12-regular text-text-weaker text-center py-4">No notes in this scope</div>}
        >
          <div class="mt-1.5 mb-3 flex gap-2.5">
            {[0, 1, 2].map((col) => (
              <div class="flex-1 min-w-0 flex flex-col gap-2.5">
                <For each={props.group.notes.filter((_, i) => i % 3 === col)}>
                  {(note) => (
                    <NoteCard note={note} originName={getOriginName(note)} onClick={() => props.onOpenNote(note.id)} />
                  )}
                </For>
              </div>
            ))}
          </div>
        </Show>
      </Show>
    </div>
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
      const result = await sdk.client.note.listAll({ directory: dir })
      return (result.data ?? []) as NoteScopeGroup[]
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
          notes = notes.filter((n) => n.title.toLowerCase().includes(q) || n.contentText.toLowerCase().includes(q))
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
        noteCreateInput: { title: "", contentText: "" },
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
        <Panel.Root>
          <Panel.Header>
            <Panel.HeaderRow>
              <Panel.Title>Notes</Panel.Title>
              <Show when={rawGroups()}>
                <Panel.Count>{totalNotes()}</Panel.Count>
              </Show>
              <Panel.Actions>
                <Panel.Action icon="refresh-ccw" title="Refresh" onClick={() => refetch()} />
                <Panel.Action icon="plus" title="New Note" onClick={() => createNoteInScope(directory() ?? "global")} />
              </Panel.Actions>
            </Panel.HeaderRow>
            <Panel.Search value={search()} onInput={setSearch} placeholder="Search notes..." />
          </Panel.Header>

          <Show when={allTags().length > 0}>
            <div class="shrink-0 px-6 pb-2">
              <div class="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <Show when={selectedTags().size > 0}>
                  <button
                    type="button"
                    class="shrink-0 flex items-center justify-center size-6 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                    onClick={() => setSelectedTags(new Set())}
                    title="Clear filters"
                  >
                    <Icon name="x" size="small" />
                  </button>
                </Show>
                <For each={allTags()}>
                  {({ tag, count }) => (
                    <Panel.FilterChip active={selectedTags().has(tag)} onClick={() => toggleTag(tag)}>
                      <span class="whitespace-nowrap">
                        {tag}
                        <span class="ml-0.5 opacity-60">{count}</span>
                      </span>
                    </Panel.FilterChip>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Panel.Body padding="tight">
            <Show when={rawGroups.loading}>
              <Panel.Loading />
            </Show>
            <Show when={!rawGroups.loading}>
              <Show
                when={displayGroups().length > 0}
                fallback={<Panel.Empty icon="notebook-pen" title="No notes found" />}
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
          </Panel.Body>
        </Panel.Root>
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

  const [note] = createResource(
    () => ({ id: props.id, dir: directory(), ver: globalSync.noteVersion() }),
    async ({ id, dir }) => {
      if (!dir) return null
      const result = await sdk.client.note.get({ id, directory: dir })
      return result.data as NoteInfo
    },
  )

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
    return {
      title: title(),
      tags: tags(),
      content: ed.getJSON(),
      contentText: ed.getText(),
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
          contentText: draft.contentText,
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
    const form = new FormData()
    form.append("file", file)
    const res = await fetch(`${sdk.url}/asset`, { method: "POST", body: form })
    const data = (await res.json()) as { id: string }
    return `${sdk.url}/asset/${data.id}`
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
          createFileUpload(sdk.url),
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
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border-base shrink-0">
          <button
            type="button"
            class="flex items-center justify-center size-8 rounded-lg text-icon-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={handleBack}
          >
            <Icon name="arrow-left" size="normal" />
          </button>

          <input
            type="text"
            class="flex-1 bg-transparent text-14-medium text-text-strong outline-none placeholder:text-text-weak/50"
            placeholder="Untitled"
            value={title()}
            onInput={onTitleInput}
          />

          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-12-medium transition-colors"
            classList={{
              "text-text-interactive-base bg-surface-interactive-base/15": baseNote()!.pinned,
              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !baseNote()!.pinned,
            }}
            onClick={togglePin}
          >
            <Icon name="pin" size="small" />
            <span>{baseNote()!.pinned ? "Pinned" : "Pin"}</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-12-medium transition-colors"
            classList={{
              "text-text-diff-add-base bg-surface-diff-add-base/10": baseNote()!.global,
              "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !baseNote()!.global,
            }}
            onClick={toggleGlobal}
          >
            <Icon name="globe" size="small" />
            <span>{baseNote()!.global ? "Global" : "Local"}</span>
          </button>

          <button
            type="button"
            class="flex items-center justify-center size-8 rounded-lg text-icon-weak hover:text-text-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={downloadNote}
            title="Download as Markdown"
          >
            <Icon name="download" size="small" />
          </button>

          <button
            type="button"
            class="flex items-center justify-center size-8 rounded-lg text-icon-weak hover:text-text-diff-delete-base hover:bg-surface-raised-base-hover transition-colors"
            onClick={deleteNote}
            title="Delete"
          >
            <Icon name="x" size="small" />
          </button>
        </div>

        <Show when={conflict()}>
          <div class="flex items-center gap-2 px-4 py-2 border-b border-border-warning-base/40 bg-surface-warning-base/10 text-12-regular text-text-base shrink-0">
            <div class="size-1.5 rounded-full bg-icon-warning-base shrink-0" />
            <span class="flex-1">{conflict()!.message}</span>
            <Show when={conflict()?.type === "remote-update"}>
              <button
                type="button"
                class="px-2 py-1 rounded-md text-11-medium text-text-base hover:bg-surface-raised-base-hover transition-colors"
                onClick={reloadRemote}
              >
                Reload remote
              </button>
              <button
                type="button"
                class="px-2 py-1 rounded-md text-11-medium text-text-interactive-base hover:bg-surface-interactive-base/10 transition-colors"
                onClick={overwriteRemote}
              >
                Overwrite remote
              </button>
            </Show>
          </div>
        </Show>

        <div class="flex items-center gap-1.5 px-5 py-2 border-b border-border-base/40 shrink-0 flex-wrap">
          <For each={tags()}>
            {(tag) => (
              <span class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-surface-interactive-base/15 text-11-medium text-text-interactive-base">
                {tag}
                <button
                  type="button"
                  class="size-3.5 flex items-center justify-center rounded-full hover:bg-surface-interactive-base/20 transition-colors"
                  onClick={() => removeTag(tag)}
                >
                  <Icon name="x" size="small" class="size-2.5" />
                </button>
              </span>
            )}
          </For>
          <input
            type="text"
            class="bg-transparent text-11-regular text-text-weak outline-none placeholder:text-text-weaker min-w-16 flex-1"
            placeholder={tags().length === 0 ? "Add tags..." : "+"}
            value={tagInput()}
            onInput={(e) => setTagInput(e.currentTarget.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={() => {
              if (tagInput().trim()) addTag(tagInput())
            }}
          />
        </div>

        <div class="flex-1 min-h-0 relative">
          <div ref={editorRef} class="h-full overflow-y-auto px-6 py-4" onClick={handleEditorAreaClick} />
          <div ref={bubbleRef} class="note-bubble-menu">
            <Show when={editor()}>
              <BubbleMenuContent editor={editor()!} />
            </Show>
          </div>

          <div class="absolute bottom-3 right-4 text-11-regular text-text-weak pointer-events-none">
            {saving() ? "Saving..." : dirty() ? "Unsaved changes" : "Saved"}
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
    border-left: 3px solid var(--border-strong-base);
    padding-left: 1em;
    margin-left: 0;
    margin-right: 0;
    font-style: italic;
    color: var(--text-weak);
  }
  .tiptap pre {
    background: #0d1117;
    border-radius: 0.5rem;
    padding: 1em;
    overflow-x: auto;
    margin-bottom: 0.75em;
  }
  .tiptap pre code {
    background: none;
    padding: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.875rem;
    color: #e6edf3;
  }
  .tiptap code {
    background: var(--surface-raised-base);
    padding: 0.2em 0.4em;
    border-radius: 0.25rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.85em;
    color: var(--text-strong);
  }
  .tiptap table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 0.75em;
  }
  .tiptap td, .tiptap th {
    border: 1px solid var(--border-weak-base);
    padding: 0.5em;
    text-align: left;
  }
  .tiptap th {
    background: var(--surface-raised-base);
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
`
