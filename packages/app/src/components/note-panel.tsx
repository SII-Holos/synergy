import { createMemo, createResource, createSignal, For, Show, createEffect, onCleanup, onMount } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import type { Editor } from "@tiptap/core"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"

import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { TIPTAP_STYLES, DocumentEditorCore } from "@/components/note/document-editor-core"
import type { BlueprintLoopInfo, NoteInfo, NoteMetaInfo, NoteMetaScopeGroup } from "@ericsanchezok/synergy-sdk/client"
import { getScopeLabel } from "@/utils/scope"
import { assetHttpUrl } from "@/utils/asset-url"
import { relativeTime } from "@/utils/time"
import "./note-panel.css"

type BlueprintStatus = "draft" | "ready" | "archived"
type LoopStatus = BlueprintLoopInfo["status"]

type NoteCardInfo = NoteMetaInfo & {
  kind?: "note" | "blueprint"
  sourceDirectory?: string
  sourceScopeID?: string
  blueprint?: NoteMetaInfo["blueprint"] & {
    description?: string
    status?: BlueprintStatus
    defaultAgent?: string
    activeLoopID?: string
    runCount?: number
    lastRunAt?: number
  }
}

type BlueprintVisualState = {
  label: string
  detail: string
  tone: "draft" | "ready" | "archived" | "running" | "waiting" | "auditing" | "failed" | "completed"
  icon: string
}

function isBlueprintNote(note: { kind?: string; blueprint?: unknown }) {
  return note.kind === "blueprint" || !!note.blueprint
}

function isActiveLoopStatus(status: LoopStatus) {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

function getLoopLabel(status: LoopStatus) {
  if (status === "armed") return "Run queued"
  if (status === "running") return "Running"
  if (status === "waiting") return "Needs input"
  if (status === "auditing") return "Reviewing"
  if (status === "completed") return "Completed"
  if (status === "failed") return "Failed"
  return "Cancelled"
}

function getLoopTone(status: LoopStatus): BlueprintVisualState["tone"] {
  if (status === "armed" || status === "running") return "running"
  if (status === "waiting") return "waiting"
  if (status === "auditing") return "auditing"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  return "archived"
}

function getStatusLabel(status: BlueprintStatus) {
  if (status === "ready") return "Ready plan"
  if (status === "archived") return "Archived"
  return "Draft plan"
}

function getRunModeLabel(mode?: BlueprintLoopInfo["runMode"]) {
  if (mode === "current") return "In current session"
  if (mode === "new") return "In new session"
  if (mode === "worktree") return "In worktree"
  return "Active run"
}

function getBlueprintVisualState(note: NoteCardInfo | NoteInfo, loops: BlueprintLoopInfo[] = []): BlueprintVisualState {
  const active = loops.find((loop) => isActiveLoopStatus(loop.status))
  if (active) {
    return {
      label: getLoopLabel(active.status),
      detail: getRunModeLabel(active.runMode),
      tone: getLoopTone(active.status),
      icon: active.status === "auditing" ? "clipboard-check" : active.status === "waiting" ? "hourglass" : "zap",
    }
  }
  const latest = loops[0]
  if (latest?.status === "failed") {
    return { label: "Run failed", detail: "Last run failed", tone: "failed", icon: "circle-x" }
  }
  const status = (note.blueprint?.status ?? "draft") as BlueprintStatus
  return {
    label: getStatusLabel(status),
    detail: status === "ready" ? "Ready to run" : status === "archived" ? "Reference only" : "Not ready to run",
    tone: status,
    icon: status === "ready" ? "circle-check" : status === "archived" ? "archive" : "file-pen",
  }
}

function getRunCount(note: NoteCardInfo | NoteInfo, loops: BlueprintLoopInfo[] = []) {
  return note.blueprint?.runCount ?? loops.length
}

function getBlueprintActivityTime(note: NoteCardInfo | NoteInfo, loops: BlueprintLoopInfo[] = []) {
  return note.blueprint?.lastRunAt ?? loops[0]?.time.updated ?? note.time.updated
}

function attachNoteDragData(e: DragEvent, note: NoteCardInfo) {
  const title = note.title || "Untitled"
  const payload = JSON.stringify({
    id: note.id,
    title: note.title,
    content: note.searchText,
  })

  e.dataTransfer!.effectAllowed = "copy"
  e.dataTransfer!.setData("application/x-synergy-note", payload)
  if (isBlueprintNote(note)) {
    e.dataTransfer!.setData(
      "application/x-synergy-blueprint",
      JSON.stringify({
        noteID: note.id,
        title: note.title,
      }),
    )
  }
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

type NoteCardVariant = "compact" | "balanced" | "featured"

function NoteCard(props: {
  note: NoteCardInfo
  originName?: string
  variant?: NoteCardVariant
  loops?: BlueprintLoopInfo[]
  onClick: () => void
}) {
  const previewHtml = createMemo(() => props.note.previewHtml ?? null)
  const searchPreview = createMemo(() => props.note.searchText ?? "")
  const hasContent = createMemo(() => (previewHtml() ?? searchPreview()).length > 0)
  const variant = createMemo(() => props.variant ?? "balanced")
  const isBlueprint = createMemo(() => isBlueprintNote(props.note))
  const blueprintState = createMemo(() => getBlueprintVisualState(props.note, props.loops ?? []))
  const cardHeight = createMemo(() => {
    if (variant() === "compact") return "h-[260px]"
    if (variant() === "featured") return "h-[370px]"
    return "h-[320px]"
  })

  return (
    <button
      type="button"
      class={`group note-card relative flex w-full ${cardHeight()} flex-col overflow-hidden rounded-[1.1rem] border border-border-weak-base bg-surface-raised-base text-left shadow-sm hover:-translate-y-0.5 hover:border-border-weak-hover hover:bg-surface-raised-base-hover hover:shadow-md active:scale-[0.985] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base`}
      classList={{
        "note-card--blueprint": isBlueprint(),
        [`note-card--blueprint-${blueprintState().tone}`]: isBlueprint(),
      }}
      draggable={true}
      onDragStart={(e) => attachNoteDragData(e, props.note)}
      onClick={props.onClick}
    >
      <Show when={props.originName}>
        <div class="absolute right-2 top-2 z-10 flex max-w-[60%] items-center gap-1 rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha/90 px-2 py-1 text-text-weak shadow-sm backdrop-blur-sm">
          <Icon name="folder" class="size-2.5 shrink-0 text-text-weak" />
          <span class="truncate text-10-medium leading-tight">{props.originName}</span>
        </div>
      </Show>

      <div class="px-3.5 pt-3.5">
        <span
          classList={{
            "line-clamp-2 text-text-strong": true,
            "text-12-medium": variant() !== "featured",
            "text-14-medium tracking-tight": variant() === "featured",
          }}
        >
          {props.note.title || "Untitled"}
        </span>
      </div>

      <Show
        when={hasContent()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-text-weaker opacity-35">
            <Icon name="notebook-pen" size="large" />
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-hidden px-3.5 pt-2">
          <Show
            when={previewHtml()}
            fallback={
              <div class="whitespace-pre-line text-[10.5px] leading-[1.35] text-text-weaker">{searchPreview()}</div>
            }
          >
            <div
              class="note-preview-content text-[10.5px] leading-[1.35] text-text-weaker"
              innerHTML={previewHtml()!}
            />
          </Show>
        </div>
      </Show>

      <div class="note-card-footer mt-auto shrink-0 border-t border-border-weaker-base px-3.5 py-2.5">
        <Show
          when={isBlueprint()}
          fallback={
            <div class="flex items-center gap-2">
              <Show when={props.note.pinned}>
                <span class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-raised-stronger-non-alpha text-text-weak">
                  <Icon name="pin" size="small" class="size-3" />
                </span>
              </Show>
              <span class="flex-1" />
              <span class="text-11-regular text-text-weak">{relativeTime(props.note.time.updated)}</span>
            </div>
          }
        >
          <div class="flex items-center gap-2">
            <span class={`note-card-status note-card-status--${blueprintState().tone}`}>
              <Icon name={blueprintState().icon} size="small" class="size-3" />
              {blueprintState().label}
            </span>
            <span class="min-w-0 flex-1 truncate text-10-regular text-text-weaker">{blueprintState().detail}</span>
            <Show when={props.note.pinned}>
              <Icon name="pin" size="small" class="size-3 shrink-0 text-text-weak" />
            </Show>
          </div>
          <div class="mt-2 flex items-center gap-2 text-11-regular text-text-weak">
            <span class="truncate">
              {getRunCount(props.note, props.loops ?? []) > 0
                ? `${getRunCount(props.note, props.loops ?? [])} runs`
                : "No runs yet"}
            </span>
            <span class="flex-1" />
            <span class="shrink-0">{relativeTime(getBlueprintActivityTime(props.note, props.loops ?? []))}</span>
          </div>
        </Show>
      </div>
    </button>
  )
}

/** Skeleton placeholder matching NoteCard shape, shown during list loading */
function NoteCardSkeleton() {
  return (
    <div class="flex w-full h-[320px] flex-col overflow-hidden rounded-[1.1rem] border border-border-weak-base bg-surface-raised-base shadow-sm animate-pulse">
      <div class="px-3.5 pt-3.5 space-y-1.5">
        <div class="h-3 w-3/4 rounded bg-surface-inset-base/70" />
        <div class="h-3 w-1/2 rounded bg-surface-inset-base/70" />
      </div>
      <div class="flex-1 px-3.5 pt-2 space-y-1">
        <div class="h-2 w-full rounded bg-surface-inset-base/70" />
        <div class="h-2 w-5/6 rounded bg-surface-inset-base/70" />
        <div class="h-2 w-2/3 rounded bg-surface-inset-base/70" />
      </div>
      <div class="shrink-0 border-t border-border-weaker-base px-3.5 py-2.5">
        <div class="ml-auto h-3 w-1/4 rounded bg-surface-inset-base/70" />
      </div>
    </div>
  )
}

function RunMenu(props: {
  title: string
  hasCurrentSession: boolean
  onRun: (mode: "current" | "new" | "worktree") => void
  onClose: () => void
}) {
  const options = [
    {
      mode: "current" as const,
      title: "Current session",
      description: props.hasCurrentSession ? "Run in the session you are viewing." : "Open a session first.",
      disabled: !props.hasCurrentSession,
    },
    {
      mode: "new" as const,
      title: "New session",
      description: "Create a fresh session in this scope and start immediately.",
      disabled: false,
    },
    {
      mode: "worktree" as const,
      title: "New worktree session",
      description: "Create an isolated worktree session and start immediately.",
      disabled: false,
    },
  ]

  return (
    <div class="note-run-menu absolute right-4 top-[3.75rem] z-40 w-[min(22rem,calc(100%-2rem))] p-3">
      <div class="px-2 pb-2">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h3 class="text-13-medium text-text-strong">Run Blueprint</h3>
            <p class="mt-1 line-clamp-2 text-11-regular text-text-weak">{props.title || "Untitled"}</p>
          </div>
          <button
            type="button"
            class="flex size-6 shrink-0 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-icon-base"
            onClick={props.onClose}
            title="Close"
          >
            <Icon name="x" size="small" class="size-3" />
          </button>
        </div>
      </div>
      <div class="space-y-1.5">
        <For each={options}>
          {(option) => (
            <button
              type="button"
              class="w-full rounded-[0.95rem] border border-border-weak-base bg-surface-raised-base px-3 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              classList={{ "cursor-not-allowed opacity-55 hover:bg-surface-raised-base": option.disabled }}
              disabled={option.disabled}
              onClick={() => props.onRun(option.mode)}
            >
              <span class="block text-12-medium text-text-strong">{option.title}</span>
              <span class="mt-0.5 block text-10-regular leading-4 text-text-weak">{option.description}</span>
            </button>
          )}
        </For>
      </div>
    </div>
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
  loopsByNote: Map<string, BlueprintLoopInfo[]>
  onToggle: () => void
  onOpenNote: (id: string) => void
  onCreateNote: () => void
  scopeLookup: Map<string, { name: string; directory: string }>
}) {
  const [columns, setColumns] = createSignal(2)
  const latestUpdated = createMemo(() => props.group.notes[0]?.time.updated)
  const noteCountLabel = createMemo(
    () => `${props.group.notes.length} ${props.group.notes.length === 1 ? "note" : "notes"}`,
  )
  const sectionClass = createMemo(() => {
    if (props.expanded) return "border-border-weak-base bg-surface-inset-base/70"
    if (props.group.isCurrent) return "bg-surface-inset-base/42"
  })

  const shelfNotes = createMemo(() => props.group.notes.slice(0, columns()))
  const hasMore = createMemo(() => props.group.notes.length > columns())

  let sectionRef!: HTMLElement

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      // section p-2 (16px) + grid px-1 (8px)
      const inner = w - 24
      const cols = inner < 380 ? 1 : inner < 660 ? 2 : 3
      setColumns(cols)
    })
    ro.observe(sectionRef)
    onCleanup(() => ro.disconnect())
  })

  function getOriginName(note: NoteMetaInfo): string | undefined {
    if (props.group.scopeType !== "global") return undefined
    const origin = note.originScope
    if (!origin) return undefined
    return props.scopeLookup.get(origin)?.name ?? origin
  }

  return (
    <section
      ref={sectionRef}
      class={`relative mb-3 overflow-hidden rounded-[1.25rem] border border-border-weak-base bg-surface-inset-base/24 p-2 transition-colors hover:bg-surface-inset-base/34 ${sectionClass()}`}
    >
      <Show when={props.group.isCurrent}>
        <div class="absolute bottom-3 left-0 top-3 w-0.5 rounded-full bg-border-strong-base/70" />
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
            <Icon name="home" size="small" class="text-icon-weak shrink-0" />
          </Show>
          <Show when={props.group.scopeType === "project"}>
            <Icon name="folder" size="small" class="text-icon-weak shrink-0" />
          </Show>
          <span class="min-w-0 truncate text-12-medium text-text-strong">{props.group.name}</span>
          <Show when={props.group.isCurrent}>
            <span class="inline-flex items-center gap-1 rounded-full bg-surface-raised-stronger-non-alpha/85 px-2 py-0.5 text-[10px] font-medium text-text-diff-add-base ring-1 ring-inset ring-border-weaker-base">
              <span class="size-1.5 rounded-full bg-text-diff-add-base/80" />
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
          <Show when={shelfNotes().length > 0}>
            <div
              class="mt-1.5 grid gap-2.5 px-1 pb-1"
              style={`grid-template-columns: repeat(${columns()}, minmax(0, 1fr))`}
            >
              <For each={shelfNotes()}>
                {(note) => (
                  <NoteCard
                    note={note}
                    originName={getOriginName(note)}
                    loops={props.loopsByNote.get(note.id) ?? []}
                    variant="compact"
                    onClick={() => props.onOpenNote(note.id)}
                  />
                )}
              </For>
            </div>
            <Show when={hasMore()}>
              <button
                type="button"
                class="flex w-full items-center justify-center gap-1 rounded-xl px-1 pb-1.5 pt-0.5 text-11-medium text-text-weak transition-colors hover:text-text-base"
                onClick={props.onToggle}
              >
                View all {props.group.notes.length} notes
                <Icon name="chevron-right" size="small" class="size-3" />
              </button>
            </Show>
          </Show>
        }
      >
        <Show
          when={props.group.notes.length > 0}
          fallback={<div class="py-4 text-center text-12-regular text-text-weaker">No notes in this scope</div>}
        >
          <div
            class="mt-2 grid gap-2.5 px-1 mb-1"
            style={`grid-template-columns: repeat(${columns()}, minmax(0, 1fr))`}
          >
            <For each={props.group.notes}>
              {(note) => (
                <NoteCard
                  note={note}
                  originName={getOriginName(note)}
                  loops={props.loopsByNote.get(note.id) ?? []}
                  variant={note.pinned ? "featured" : "balanced"}
                  onClick={() => props.onOpenNote(note.id)}
                />
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

  const [loops, { refetch: refetchLoops }] = createResource(
    () => directory(),
    async (dir) => {
      if (!dir) return [] as BlueprintLoopInfo[]
      try {
        const result = await sdk.client.blueprint.loop.list({ directory: dir })
        return [...((result.data ?? []) as BlueprintLoopInfo[])].sort((a, b) => b.time.updated - a.time.updated)
      } catch (error) {
        console.error("Failed to load blueprint loops", error)
        return [] as BlueprintLoopInfo[]
      }
    },
  )

  const loopsByNote = createMemo(() => {
    const map = new Map<string, BlueprintLoopInfo[]>()
    for (const loop of loops() ?? []) {
      const items = map.get(loop.noteID) ?? []
      items.push(loop)
      map.set(loop.noteID, items)
    }
    return map
  })

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
        const groupDirectory =
          meta?.directory ?? (g.scopeID === "global" ? "global" : isCurrent ? (directory() ?? "") : "")
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
          directory: groupDirectory,
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
    if (!dir) return
    setSelectedNoteId(id)
    setSelectedNoteDir(dir)
    setView("editor")
  }

  async function createNoteInScope(dir: string) {
    if (!dir) return
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
                        loopsByNote={loopsByNote()}
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
            refetchLoops()
          }}
          onDelete={() => {
            setView("list")
            refetch()
            refetchLoops()
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
  const platform = usePlatform()
  const params = useParams()
  const navigate = useNavigate()
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
  const [convertingBlueprint, setConvertingBlueprint] = createSignal(false)
  const [runningBlueprint, setRunningBlueprint] = createSignal(false)
  const [showRunMenu, setShowRunMenu] = createSignal(false)

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let saveQueued = false
  let saveInFlight: Promise<void> | undefined

  const noteLoaded = createMemo(() => !!baseNote())
  const isBlueprint = createMemo(() => baseNote()?.kind === "blueprint")
  const [noteLoops, { refetch: refetchLoops }] = createResource(
    () => ({ id: props.id, dir: directory(), ver: globalSync.noteVersion() }),
    async ({ id, dir }) => {
      if (!dir) return [] as BlueprintLoopInfo[]
      try {
        const result = await sdk.client.blueprint.loop.list({ directory: dir })
        return ((result.data ?? []) as BlueprintLoopInfo[])
          .filter((loop) => loop.noteID === id)
          .sort((a, b) => b.time.updated - a.time.updated)
      } catch (error) {
        console.error("Failed to load blueprint loops", error)
        return [] as BlueprintLoopInfo[]
      }
    },
  )
  const blueprintState = createMemo(() => {
    const base = baseNote()
    if (!base) return null
    return getBlueprintVisualState(base, noteLoops() ?? [])
  })

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

  async function convertToBlueprint() {
    const dir = directory()
    const base = baseNote()
    if (!dir || !base || isBlueprint() || convertingBlueprint()) return
    if (dirty()) {
      setConflict({
        type: "metadata-blocked",
        message: "Save or reload your draft before converting this note to a Blueprint.",
      })
      return
    }

    setConvertingBlueprint(true)
    try {
      const result = await sdk.client.note.update({
        id: base.id,
        directory: dir,
        notePatchInput: {
          kind: "blueprint",
          blueprint: { status: "draft" as const },
          expectedVersion: base.version,
        },
      })
      applySnapshot(result.data as NoteInfo)
    } catch (error) {
      const remote = parseConflict(error)
      if (remote) {
        setConflict({
          type: "remote-update",
          message: "This note changed before it could be converted to a Blueprint.",
          remote,
        })
        return
      }
      console.error("Failed to convert note to blueprint", error)
    } finally {
      setConvertingBlueprint(false)
    }
  }

  async function convertToNote() {
    const dir = directory()
    const base = baseNote()
    if (!dir || !base || !isBlueprint() || convertingBlueprint()) return
    if (dirty()) {
      setConflict({
        type: "metadata-blocked",
        message: "Save or reload your draft before converting this Blueprint to a Note.",
      })
      return
    }
    if (base.blueprint?.activeLoopID || (noteLoops() ?? []).some((loop) => isActiveLoopStatus(loop.status))) {
      alert("This Blueprint has an active loop. Finish or cancel the loop before converting it back to a Note.")
      return
    }

    setConvertingBlueprint(true)
    try {
      const result = await sdk.client.note.update({
        id: base.id,
        directory: dir,
        notePatchInput: {
          kind: "note",
          blueprint: null,
          expectedVersion: base.version,
        },
      })
      applySnapshot(result.data as NoteInfo)
      await refetchLoops()
    } catch (error) {
      const remote = parseConflict(error)
      if (remote) {
        setConflict({
          type: "remote-update",
          message: "This Blueprint changed before it could be converted to a Note.",
          remote,
        })
        return
      }
      console.error("Failed to convert blueprint to note", error)
    } finally {
      setConvertingBlueprint(false)
    }
  }

  async function createExecutionSession(mode: "current" | "new" | "worktree", blueprintDir: string) {
    if (mode === "current") {
      if (!params.id) {
        alert("Open a session before running this Blueprint in the current session.")
        return undefined
      }
      return { sessionID: params.id, directory: blueprintDir }
    }

    let targetDirectory = blueprintDir
    let client = sdk.client

    if (mode === "worktree") {
      const worktree = await sdk.client.worktree.create({ directory: blueprintDir }).then((result) => result.data)
      if (!worktree?.path) throw new Error("Failed to create worktree")
      targetDirectory = worktree.path
      client = createSynergyClient({
        baseUrl: sdk.url,
        fetch: platform.fetch,
        directory: targetDirectory,
        throwOnError: true,
      })
      globalSync.child(targetDirectory)
    }

    const session = await client.session.create({}).then((result) => result.data)
    if (!session?.id) throw new Error("Failed to create session")
    return { sessionID: session.id, directory: targetDirectory }
  }

  async function runBlueprint(mode: "current" | "new" | "worktree") {
    const dir = directory()
    if (!dir || runningBlueprint()) return
    await flushSave()
    if (remoteConflict()) return
    const base = baseNote()
    if (!base || !isBlueprint()) return

    setRunningBlueprint(true)
    try {
      const target = await createExecutionSession(mode, dir)
      if (!target) return
      const loop = await sdk.client.blueprint.loop
        .create({
          directory: dir,
          blueprintLoopCreateInput: {
            noteID: base.id,
            noteVersion: base.version,
            title: base.title || "Blueprint run",
            description: base.blueprint?.description,
            sessionID: target.sessionID,
            runMode: mode,
          },
        })
        .then((result) => result.data)
      if (!loop?.id) throw new Error("Failed to create BlueprintLoop")
      await sdk.client.blueprint.loop.start({ id: loop.id, directory: dir })
      setShowRunMenu(false)
      await refetchLoops()
      await refetch()
      navigate(`/${base64Encode(target.directory)}/session/${target.sessionID}`)
    } catch (error) {
      console.error("Failed to run blueprint", error)
      alert(error instanceof Error ? error.message : "Failed to run blueprint")
    } finally {
      setRunningBlueprint(false)
    }
  }

  async function deleteNote() {
    const dir = directory()
    if (!dir) return
    if (!confirm("Are you sure you want to delete this note?")) return
    await sdk.client.note.remove({ id: props.id, directory: dir })
    props.onDelete()
  }

  return (
    <div class="relative flex flex-col h-full bg-background-base">
      <Show when={note.loading && !noteLoaded()}>
        <div class="flex items-center justify-center h-full">
          <Spinner class="size-6" />
        </div>
      </Show>

      <Show when={noteLoaded() && baseNote()}>
        <div class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base px-4 py-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              onClick={handleBack}
              title="Back to list"
            >
              <Icon name="arrow-left" size="normal" />
            </button>

            <div class="min-w-0 flex-1 px-2 py-1.5">
              <input
                type="text"
                class="w-full bg-transparent text-14-medium tracking-tight text-text-strong outline-none placeholder:text-text-weak/50"
                placeholder="Untitled"
                value={title()}
                onInput={onTitleInput}
              />
            </div>

            <Show when={isBlueprint()}>
              <button
                type="button"
                class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-success-base/58 px-3 text-11-medium text-text-diff-add-base transition-colors hover:bg-surface-success-base/82 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-success-base/35 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => setShowRunMenu((current) => !current)}
                disabled={runningBlueprint()}
                title="Run Blueprint"
              >
                <Show when={!runningBlueprint()} fallback={<Spinner class="size-3.5" />}>
                  <Icon name="zap" size="small" class="size-3" />
                </Show>
                <span>Run</span>
              </button>
            </Show>

            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-11-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              classList={{
                "bg-surface-inset-base text-text-base": baseNote()!.pinned,
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
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-11-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              classList={{
                "bg-surface-diff-add-base/12 text-text-diff-add-base": baseNote()!.global,
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
              class="flex size-8 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              onClick={downloadNote}
              title="Download as Markdown"
            >
              <Icon name="download" size="small" />
            </button>
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-11-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              classList={{
                "bg-surface-inset-base text-text-base": isBlueprint(),
                "bg-surface-raised-stronger-non-alpha text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base":
                  !isBlueprint(),
                "opacity-60 cursor-not-allowed": convertingBlueprint(),
              }}
              onClick={() => {
                if (isBlueprint()) void convertToNote()
                else void convertToBlueprint()
              }}
              title={isBlueprint() ? "Convert to Note" : "Convert to Blueprint"}
              disabled={convertingBlueprint()}
            >
              <Show when={!convertingBlueprint()} fallback={<Spinner class="size-3.5" />}>
                <Icon name={isBlueprint() ? "notebook-pen" : getSemanticIcon("orchestration.blueprint")} size="small" />
              </Show>
              <span>{isBlueprint() ? "To Note" : "To Blueprint"}</span>
            </button>

            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35"
              onClick={deleteNote}
              title="Delete"
            >
              <Icon name="trash-2" size="small" />
            </button>
          </div>
        </div>

        <Show when={isBlueprint() && blueprintState()}>
          <div class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base px-4 py-2.5">
            <div class="note-blueprint-meta flex flex-wrap items-center gap-2">
              <span class={`note-card-status note-card-status--${blueprintState()!.tone}`}>
                <Icon name={blueprintState()!.icon} size="small" class="size-3" />
                {blueprintState()!.label}
              </span>
              <span class="text-11-regular text-text-weak">{blueprintState()!.detail}</span>
              <span class="h-3 w-px bg-border-weaker-base" />
              <span class="text-11-regular text-text-weak">
                {getRunCount(baseNote()!, noteLoops() ?? []) > 0
                  ? `${getRunCount(baseNote()!, noteLoops() ?? [])} runs`
                  : "No runs yet"}
              </span>
              <span class="h-3 w-px bg-border-weaker-base" />
              <span class="text-11-regular text-text-weak">
                Last activity {relativeTime(getBlueprintActivityTime(baseNote()!, noteLoops() ?? []))}
              </span>
              <Show when={baseNote()!.blueprint?.defaultAgent}>
                <span class="h-3 w-px bg-border-weaker-base" />
                <span class="text-11-regular text-text-weak">{baseNote()!.blueprint!.defaultAgent}</span>
              </Show>
            </div>
          </div>
        </Show>

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
                  class="rounded-full bg-surface-success-base/40 px-3 py-1.5 text-11-medium text-text-diff-add-base transition-colors hover:bg-surface-success-base/62"
                  onClick={overwriteRemote}
                >
                  Overwrite remote
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <div class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base px-4 py-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <For each={tags()}>
              {(tag) => (
                <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-inset-base/68 px-2.5 py-1.5 text-11-medium text-text-weak">
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
            <div class="flex min-w-[7rem] flex-1 items-center gap-2 rounded-full px-1 py-1.5">
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

        <DocumentEditorCore
          content={baseNote()!.content}
          onUpdate={() => {
            markDirty()
            scheduleSave()
          }}
          onEditorReady={(instance) => setEditor(instance)}
          uploadFile={uploadFile}
          sdkClient={sdk.client}
          sdkUrl={sdk.url}
          saving={saving()}
        />

        <Show when={showRunMenu() && isBlueprint() && baseNote()}>
          <RunMenu
            title={baseNote()!.title || "Untitled"}
            hasCurrentSession={!!params.id}
            onRun={runBlueprint}
            onClose={() => setShowRunMenu(false)}
          />
        </Show>
      </Show>
    </div>
  )
}
