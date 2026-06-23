import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { TIPTAP_STYLES, DocumentEditorCore } from "@/components/note/document-editor-core"
import type {
  NoteMetaInfo,
  NoteInfo,
  BlueprintLoopInfo,
  BlueprintLoopActivity,
} from "@ericsanchezok/synergy-sdk/client"
import { assetHttpUrl } from "@/utils/asset-url"
import { relativeTime } from "@/utils/time"
import "./blueprint-panel.css"

// ---------------------------------------------------------------------------
// Local type that extends NoteMetaInfo with the full blueprint shape from NoteInfo
// (NoteMetaInfo only exposes activeLoopID/runCount/lastRunAt in its blueprint field)
// ---------------------------------------------------------------------------

type BlueprintMetaInfo = NoteMetaInfo & {
  kind?: "blueprint" | "note"
  sourceDirectory?: string
  sourceScopeID?: string
  blueprint?: {
    status?: "draft" | "ready" | "archived"
    activeLoopID?: string
    runCount?: number
    lastRunAt?: number
    defaultAgent?: string
    description?: string
  }
}

type LoopStatus = BlueprintLoopInfo["status"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOOP_STATUS_ICONS: Record<LoopStatus, string> = {
  armed: "circle",
  running: "zap",
  waiting: "hourglass",
  auditing: "clipboard-check",
  completed: "circle-check",
  failed: "circle-x",
  cancelled: "circle-stop",
}

function isActiveLoop(s: LoopStatus) {
  return s === "running" || s === "waiting" || s === "auditing"
}

// Run menu
// ---------------------------------------------------------------------------

function RunMenu(props: {
  blueprint: BlueprintMetaInfo
  hasCurrentSession: boolean
  onRun: (mode: "current" | "new" | "worktree") => void
  onClose: () => void
}) {
  const options = [
    {
      mode: "current" as const,
      title: "Current session",
      description: props.hasCurrentSession
        ? "Run in the session you are viewing."
        : "Open a session first to use this mode.",
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
    <div class="bp-modal-backdrop fixed inset-0 z-50 flex items-start justify-center pt-24" onClick={props.onClose}>
      <div class="bp-card mx-4 w-full max-w-sm p-3" onClick={(e) => e.stopPropagation()}>
        <div class="px-2 pb-2">
          <h3 class="text-13-medium text-text-strong">Run Blueprint</h3>
          <p class="mt-1 text-11-regular text-text-weak line-clamp-2">{props.blueprint.title || "Untitled"}</p>
        </div>
        <div class="space-y-1.5">
          <For each={options}>
            {(option) => (
              <button
                type="button"
                class="w-full rounded-[0.95rem] border border-border-weak-base bg-surface-raised-base px-3 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover"
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Blueprint detail / editor view
// ---------------------------------------------------------------------------

function BlueprintDetail(props: {
  id: string
  directory: string
  allBps: () => BlueprintMetaInfo[]
  onBack: () => void
  onRun: () => void
  onConvertToNote: () => void
  onDelete: () => void
  sdkClient: ReturnType<typeof import("@ericsanchezok/synergy-sdk/client").createSynergyClient>
  sdkUrl: string
}) {
  const bpMeta = createMemo(() => props.allBps().find((b) => b.id === props.id))

  // Fetch full note content for editor
  const [note] = createResource(
    () => ({ id: props.id, dir: props.directory }),
    async ({ id, dir }) => {
      if (!dir) return null
      const result = await props.sdkClient.note.get({ id, directory: dir })
      return (result.data ?? null) as NoteInfo | null
    },
  )

  const content = createMemo(() => note()?.content)
  const bp = createMemo(() => {
    const full = note()
    if (!full) return bpMeta()
    return {
      ...bpMeta(),
      blueprint: full.blueprint ?? bpMeta()?.blueprint,
    } as BlueprintMetaInfo
  })

  // Wait for bp() to resolve
  const ready = createMemo(() => bp() !== undefined)

  return (
    <div class="bp-detail-enter flex flex-col h-full">
      <Show
        when={ready()}
        fallback={
          <div class="flex items-center justify-center h-full">
            <Spinner class="size-6" />
          </div>
        }
      >
        {/* Shell bar */}
        <div class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base px-4 py-3">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-text-interactive-base/35"
              onClick={props.onBack}
              title="Back to list"
            >
              <Icon name="arrow-left" size="normal" />
            </button>

            <div class="min-w-0 flex-1 px-2 py-1.5">
              <span class="text-14-medium tracking-tight text-text-strong truncate block">
                {bp()!.title || "Untitled Blueprint"}
              </span>
            </div>

            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-interactive-base/14 px-3 text-11-medium text-text-interactive-base transition-colors hover:bg-surface-interactive-base/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-text-interactive-base/35"
              onClick={props.onRun}
              title="Run Blueprint"
            >
              <Icon name="zap" size="small" class="size-3" />
              <span>Run</span>
            </button>

            <button
              type="button"
              class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-raised-stronger-non-alpha px-3 text-11-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-interactive-base focus:outline-none focus-visible:ring-2 focus-visible:ring-text-interactive-base/35"
              onClick={props.onConvertToNote}
              title="Convert to Note"
            >
              <Icon name="notebook-pen" size="small" class="size-3" />
              <span>To Note</span>
            </button>

            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full text-icon-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base focus:outline-none focus-visible:ring-2 focus-visible:ring-text-interactive-base/35"
              onClick={props.onDelete}
              title="Delete"
            >
              <Icon name="trash-2" size="small" />
            </button>
          </div>
        </div>
        {/* Tags */}
        <div class="shrink-0 border-b border-border-weaker-base bg-surface-raised-base px-4 py-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={(bp()!.tags ?? []).length > 0}
              fallback={<span class="text-11-regular text-text-weaker">No tags</span>}
            >
              <For each={bp()!.tags ?? []}>
                {(tag) => (
                  <span class="inline-flex items-center rounded-full bg-surface-inset-base/68 px-2.5 py-1.5 text-11-medium text-text-weak">
                    {tag}
                  </span>
                )}
              </For>
            </Show>
          </div>
        </div>
        {/* Editor */}
        <div class="flex flex-1 min-h-0 flex-col overflow-hidden">
          <DocumentEditorCore
            content={content()}
            // Detail view is read-only; Blueprint content editing stays in the Note editor shell.
            onUpdate={() => {}}
            onEditorReady={() => {}}
            uploadFile={async (file: File) => {
              const res = await props.sdkClient.asset.upload({ file })
              return assetHttpUrl(props.sdkUrl, res.data as { id?: string; url?: string } | undefined)
            }}
            sdkClient={props.sdkClient}
            sdkUrl={props.sdkUrl}
            saving={false}
          />
        </div>
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drag data for prompt-input drop target
// ---------------------------------------------------------------------------

function attachBlueprintDragData(e: DragEvent, note: BlueprintMetaInfo) {
  const title = note.title || "Untitled"
  const payload = JSON.stringify({
    noteID: note.id,
    title: note.title,
  })

  e.dataTransfer!.effectAllowed = "copy"
  e.dataTransfer!.setData("application/x-synergy-blueprint", payload)
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

type BlueprintStatus = NonNullable<NonNullable<BlueprintMetaInfo["blueprint"]>["status"]>

const BLUEPRINT_STATUS_ICONS: Record<BlueprintStatus, string> = {
  draft: "file-pen",
  ready: "circle-check",
  archived: "archive",
}

function getBlueprintStatus(bp: BlueprintMetaInfo): BlueprintStatus {
  return bp.blueprint?.status ?? "draft"
}

function getBlueprintSummary(bp: BlueprintMetaInfo) {
  const source = bp.blueprint?.description || bp.searchText || ""
  let text = source.replace(/\s+/g, " ").trim()
  const title = (bp.title || "").replace(/\s+/g, " ").trim()
  if (title && text.startsWith(title)) text = text.slice(title.length).trim()
  if (text.length <= 180) return text
  return `${text.slice(0, 180).trim()}...`
}

function BlueprintPlanRow(props: {
  bp: BlueprintMetaInfo
  loops: BlueprintLoopInfo[]
  onOpen: () => void
  onRun?: () => void
}) {
  const status = createMemo(() => getBlueprintStatus(props.bp))
  const summary = createMemo(() => getBlueprintSummary(props.bp))
  const hasActive = createMemo(() => props.loops.some((loop) => isActiveLoop(loop.status)))
  const lastActivity = createMemo(() => props.bp.blueprint?.lastRunAt ?? props.bp.time.updated)
  const runCount = createMemo(() => props.bp.blueprint?.runCount ?? props.loops.length)

  return (
    <div
      class="bp-plan-row group flex items-stretch gap-2"
      classList={{
        "bp-plan-row-active": hasActive(),
        "opacity-70": status() === "archived",
      }}
      draggable={true}
      onDragStart={(e) => attachBlueprintDragData(e, props.bp)}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-3 rounded-[0.85rem] px-3 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-text-interactive-base/35"
        onClick={props.onOpen}
      >
        <span
          class={`bp-plan-status-mark bp-plan-status-${status()}`}
          classList={{ "bp-plan-status-running": hasActive() }}
        >
          <Icon name={hasActive() ? "zap" : BLUEPRINT_STATUS_ICONS[status()]} size="small" class="size-3.5" />
        </span>

        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-center gap-2">
            <span class="truncate text-13-medium text-text-strong">{props.bp.title || "Untitled Blueprint"}</span>
            <span
              class="bp-status shrink-0"
              classList={{
                "bp-status-active": hasActive(),
                "bp-status-draft": !hasActive() && status() === "draft",
                "bp-status-ready": !hasActive() && status() === "ready",
                "bp-status-archived": !hasActive() && status() === "archived",
              }}
            >
              {hasActive() ? "active" : status()}
            </span>
          </span>
          <Show when={summary()}>
            <span class="bp-plan-summary">{summary()}</span>
          </Show>
          <span class="mt-2 flex flex-wrap items-center gap-1.5">
            <For each={(props.bp.tags ?? []).slice(0, 3)}>{(tag) => <span class="bp-plan-tag">{tag}</span>}</For>
            <Show when={props.bp.blueprint?.defaultAgent}>
              <span class="bp-plan-meta">
                <Icon name="workflow" size="small" class="size-3" />
                {props.bp.blueprint!.defaultAgent}
              </span>
            </Show>
          </span>
        </span>
      </button>

      <div class="flex w-28 shrink-0 flex-col items-end justify-between gap-2 py-3 pr-3">
        <div class="text-right">
          <Show when={runCount() > 0}>
            <div class="text-11-medium text-text-base">{runCount()} runs</div>
          </Show>
          <div class="text-10-regular text-text-weaker">{relativeTime(lastActivity())}</div>
        </div>
        <Show when={status() === "ready" && props.onRun}>
          <button
            type="button"
            class="inline-flex h-7 items-center gap-1.5 rounded-full bg-surface-interactive-base/14 px-2.5 text-10-medium text-text-interactive-base transition-colors hover:bg-surface-interactive-base/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-text-interactive-base/35"
            onClick={props.onRun}
            title="Run Blueprint"
          >
            <Icon name="zap" size="small" class="size-3" />
            Run
          </button>
        </Show>
      </div>
    </div>
  )
}

function BlueprintListSection(props: {
  title: string
  subtitle: string
  items: BlueprintMetaInfo[]
  loopsByNote: Map<string, BlueprintLoopInfo[]>
  onOpen: (bp: BlueprintMetaInfo) => void
  onRun?: (bp: BlueprintMetaInfo) => void
}) {
  return (
    <Show when={props.items.length > 0}>
      <section class="bp-plan-section">
        <div class="mb-2 flex items-center gap-2 px-0.5">
          <span class="text-11-semibold text-text-base">{props.title}</span>
          <span class="rounded-full bg-surface-inset-base/70 px-1.5 py-0.5 text-10-medium text-text-weak">
            {props.items.length}
          </span>
          <span class="min-w-0 truncate text-10-regular text-text-weaker">{props.subtitle}</span>
        </div>
        <div class="space-y-2">
          <For each={props.items}>
            {(bp) => (
              <BlueprintPlanRow
                bp={bp}
                loops={props.loopsByNote.get(bp.id) ?? []}
                onOpen={() => props.onOpen(bp)}
                onRun={props.onRun ? () => props.onRun!(bp) : undefined}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function BlueprintPanel() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const navigate = useNavigate()
  const globalSync = useGlobalSync()
  const params = useParams()
  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const currentScopeID = createMemo(() => {
    const dir = directory()
    if (!dir || dir === "global") return "global"
    const scope = globalSync.data.scope.find((s) => s.worktree === dir || (s.sandboxes ?? []).includes(dir))
    return scope?.id ?? ""
  })

  const [view, setView] = createSignal<"list" | "detail">("list")
  const [selectedBpId, setSelectedBpId] = createSignal<string | null>(null)
  const [selectedBpDir, setSelectedBpDir] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal("")
  const [showRunMenu, setShowRunMenu] = createSignal(false)
  const scopeDirectoryKey = createMemo(() =>
    globalSync.data.scope.map((scope) => `${scope.id}:${scope.worktree}`).join("|"),
  )

  function resolveScopeDirectory(scopeID: string) {
    if (scopeID === "global") return "global"
    const currentDir = directory()
    if (currentDir && scopeID === currentScopeID()) return currentDir
    return globalSync.data.scope.find((s) => s.id === scopeID)?.worktree
  }

  // Fetch all notes, filter blueprints
  const [blueprintMeta, { refetch: refetchNotes }] = createResource(
    () => ({ dir: directory(), ver: globalSync.noteVersion(), scopeKey: scopeDirectoryKey() }),
    async ({ dir }) => {
      if (!dir) return [] as BlueprintMetaInfo[]
      const result = await sdk.client.note.listMeta({ directory: dir })
      const blueprints: BlueprintMetaInfo[] = []
      for (const g of result.data ?? []) {
        const sourceDirectory = resolveScopeDirectory(g.scopeID)
        if (!sourceDirectory) continue
        for (const n of g.notes) {
          if (n.kind === "blueprint") {
            blueprints.push({
              ...(n as BlueprintMetaInfo),
              sourceDirectory,
              sourceScopeID: g.scopeID,
            })
          }
        }
      }
      return blueprints
    },
  )

  // Fetch all loops via SDK
  const [loops, { refetch: refetchLoops }] = createResource(
    () => directory(),
    async (_dir) => {
      if (!_dir) return [] as BlueprintLoopInfo[]
      try {
        const result = await sdk.client.blueprint.loop.list()
        return (result.data ?? []) as BlueprintLoopInfo[]
      } catch {
        return [] as BlueprintLoopInfo[]
      }
    },
  )

  const allBlueprints = createMemo(() => {
    const bps = blueprintMeta() ?? []
    const q = search().toLowerCase().trim()
    if (!q) return bps
    return bps.filter((bp) => bp.title.toLowerCase().includes(q))
  })

  const readyBps = createMemo(() => allBlueprints().filter((bp) => bp.blueprint?.status === "ready"))
  const draftBps = createMemo(() =>
    allBlueprints().filter((bp) => !bp.blueprint?.status || bp.blueprint.status === "draft"),
  )
  const archivedBps = createMemo(() => allBlueprints().filter((bp) => bp.blueprint?.status === "archived"))

  const totalBlueprints = createMemo(() => (blueprintMeta() ?? []).length)
  const activeLoops = createMemo(() => (loops() ?? []).filter((l) => isActiveLoop(l.status)))
  const loopsByNote = createMemo(() => {
    const map = new Map<string, BlueprintLoopInfo[]>()
    for (const l of loops() ?? []) {
      const arr = map.get(l.noteID) ?? []
      arr.push(l)
      map.set(l.noteID, arr)
    }
    return map
  })

  function openDetail(id: string, dir: string) {
    setSelectedBpId(id)
    setSelectedBpDir(dir)
    setView("detail")
  }

  async function createExecutionSession(mode: "current" | "new" | "worktree", blueprintDir: string) {
    const dir = blueprintDir
    if (!dir) return undefined

    if (mode === "current") {
      if (!params.id) {
        alert("Open a session before running this Blueprint in the current session.")
        return undefined
      }
      return { sessionID: params.id, directory: dir }
    }

    let targetDirectory = dir
    let client = sdk.client

    if (mode === "worktree") {
      const worktree = await sdk.client.worktree.create({ directory: dir }).then((result) => result.data)
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
    const bp = allBlueprints().find((b) => b.id === selectedBpId())
    if (!bp) return
    const blueprintDir = bp.sourceDirectory ?? selectedBpDir() ?? directory()
    if (!blueprintDir) return
    try {
      const target = await createExecutionSession(mode, blueprintDir)
      if (!target) return
      const loop = await sdk.client.blueprint.loop
        .create({
          directory: blueprintDir,
          blueprintLoopCreateInput: {
            noteID: bp.id,
            title: bp.title || "Blueprint run",
            description: bp.blueprint?.description,
            sessionID: target.sessionID,
            runMode: mode,
          },
        })
        .then((result) => result.data)
      if (!loop?.id) throw new Error("Failed to create BlueprintLoop")
      await sdk.client.blueprint.loop.start({ id: loop.id, directory: blueprintDir })
      setShowRunMenu(false)
      await refetchLoops()
      await refetchNotes()
      navigate(`/${base64Encode(target.directory)}/session/${target.sessionID}`)
    } catch (e) {
      console.error("Failed to run blueprint", e)
      alert(e instanceof Error ? e.message : "Failed to run blueprint")
    }
  }

  async function convertToNote() {
    const bp = allBlueprints().find((b) => b.id === selectedBpId())
    if (!bp) return
    const dir = selectedBpDir() ?? directory()
    if (!dir) return
    if (bp.blueprint?.activeLoopID) {
      alert("This Blueprint has an active loop. Finish or cancel the loop before converting it back to a Note.")
      return
    }

    try {
      await sdk.client.note.update({
        id: bp.id,
        directory: dir,
        notePatchInput: { kind: "note", blueprint: null },
      })
      await refetchNotes()
      setView("list")
      setSelectedBpId(null)
    } catch (e) {
      console.error("Failed to convert blueprint to note", e)
    }
  }

  async function deleteBlueprint() {
    const bp = allBlueprints().find((b) => b.id === selectedBpId())
    if (!bp) return
    const dir = selectedBpDir() ?? directory()
    if (!dir) return
    if (!confirm("Are you sure you want to delete this blueprint?")) return

    try {
      await sdk.client.note.remove({ id: bp.id, directory: dir })
      setView("list")
      setSelectedBpId(null)
      await refetchNotes()
    } catch (e) {
      console.error("Failed to delete blueprint", e)
    }
  }

  return (
    <div class="bp-panel flex flex-col h-full relative">
      <style>{TIPTAP_STYLES}</style>

      <Show when={view() === "list"}>
        <div class="flex flex-col h-full">
          {/* Search bar */}
          <div class="shrink-0 px-4 pt-3 pb-2">
            <div class="bp-search flex items-center gap-2 px-3.5 py-2">
              <Icon name="search" size="small" class="text-icon-weak shrink-0" />
              <input
                type="text"
                placeholder="Search blueprints..."
                class="min-w-0 flex-1"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
              <Show when={search()}>
                <button
                  type="button"
                  class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-icon-base"
                  onClick={() => setSearch("")}
                >
                  <Icon name="x" size="small" />
                </button>
              </Show>
              <span class="text-11-regular text-text-weak mr-0.5">{totalBlueprints()}</span>
              <button
                type="button"
                class="flex items-center justify-center size-7 rounded-lg text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                onClick={() => {
                  void refetchNotes()
                  void refetchLoops()
                }}
                title="Refresh"
              >
                <Icon name="refresh-ccw" size="small" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div class="flex-1 min-h-0 overflow-y-auto bp-scroll px-4 pb-6">
            <Show when={blueprintMeta.loading || loops.loading}>
              <div class="flex items-center justify-center py-16">
                <Spinner class="size-6" />
              </div>
            </Show>

            <Show when={!blueprintMeta.loading}>
              {/* Active loops */}
              <Show when={activeLoops().length > 0}>
                <div class="mb-4">
                  <div class="flex items-center gap-2 mb-2.5 px-0.5">
                    <div class="size-1.5 rounded-full bg-text-diff-add-base animate-pulse" />
                    <span class="text-11-semibold text-text-base">Active Loops</span>
                    <span class="text-10-regular text-text-weak">{activeLoops().length}</span>
                  </div>
                  <div class="space-y-2">
                    <For each={activeLoops()}>
                      {(loop) => {
                        const bp = allBlueprints().find((b) => b.id === loop.noteID)
                        const [activity] = createResource(
                          () => loop.id,
                          (id) =>
                            sdk.client.blueprint.loop
                              .activity({ id })
                              .then((r) => r.data)
                              .catch(() => undefined),
                        )
                        return (
                          <div class="bp-card bp-card-active px-3.5 py-3 flex flex-col gap-2">
                            <div class="flex items-center gap-2">
                              <Icon
                                name={LOOP_STATUS_ICONS[loop.status]}
                                size="small"
                                class="text-text-interactive-base shrink-0"
                              />
                              <span class="text-11-semibold text-text-strong truncate">{loop.title}</span>
                              <Show when={bp}>
                                <span class="text-10-regular text-text-weak truncate">({bp!.title})</span>
                              </Show>
                              <span class="flex-1" />
                              <span class={`bp-loop-status bp-loop-${loop.status}`}>{loop.status}</span>
                            </div>

                            <div class="flex items-center gap-3 text-10-regular text-text-weaker">
                              <Show when={loop.runMode}>
                                <span>Mode: {loop.runMode}</span>
                              </Show>
                              <Show when={loop.loopIndex !== undefined}>
                                <span>#{loop.loopIndex! + 1}</span>
                              </Show>
                              <span>{relativeTime(loop.time.updated)}</span>
                              <Show when={activity()}>
                                <span>
                                  · {(activity() as BlueprintLoopActivity).stepCount} s /{" "}
                                  {(activity() as BlueprintLoopActivity).messageCount} m
                                </span>
                              </Show>
                            </div>

                            <Show when={loop.sessionID}>
                              <button
                                type="button"
                                class="bp-card px-2 py-0.5 text-10-medium text-text-interactive-base transition-colors hover:bg-surface-interactive-base/8 w-fit"
                                onClick={() => {
                                  window.open(`/${params.dir}/session/${loop.sessionID}`, "_self")
                                }}
                              >
                                Open session
                              </button>
                            </Show>

                            <Show when={loop.error}>
                              <div class="bp-card rounded-md px-2.5 py-1 bg-surface-diff-delete-base/6 border border-border-diff-delete-base/18 text-10-regular text-text-diff-delete-base">
                                {loop.error}
                              </div>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              <BlueprintListSection
                title="Ready plans"
                subtitle="Runnable blueprints with a defined next step"
                items={readyBps()}
                loopsByNote={loopsByNote()}
                onOpen={(bp) => openDetail(bp.id, bp.sourceDirectory ?? directory()!)}
                onRun={(bp) => {
                  setSelectedBpId(bp.id)
                  setSelectedBpDir(bp.sourceDirectory ?? directory() ?? null)
                  setShowRunMenu(true)
                }}
              />

              <BlueprintListSection
                title="Draft plans"
                subtitle="Designs still being shaped"
                items={draftBps()}
                loopsByNote={loopsByNote()}
                onOpen={(bp) => openDetail(bp.id, bp.sourceDirectory ?? directory()!)}
              />

              <BlueprintListSection
                title="Archived plans"
                subtitle="Kept for reference"
                items={archivedBps()}
                loopsByNote={loopsByNote()}
                onOpen={(bp) => openDetail(bp.id, bp.sourceDirectory ?? directory()!)}
              />

              {/* Empty state */}
              <Show when={allBlueprints().length === 0 && !blueprintMeta.loading}>
                <div class="flex flex-col items-center justify-center py-16 gap-3">
                  <Icon name={getSemanticIcon("orchestration.blueprint")} size="large" class="text-icon-weak" />
                  <div class="text-14-medium text-text-weak">No blueprints yet</div>
                  <div class="text-11-regular text-text-weaker">
                    Convert an existing note into a blueprint from its editor.
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </Show>

      {/* Detail view */}
      <Show when={view() === "detail" && selectedBpId()}>
        <BlueprintDetail
          id={selectedBpId()!}
          directory={selectedBpDir() ?? directory() ?? ""}
          allBps={allBlueprints}
          onBack={() => {
            setView("list")
            void refetchNotes()
            void refetchLoops()
          }}
          onRun={() => setShowRunMenu(true)}
          onConvertToNote={convertToNote}
          onDelete={deleteBlueprint}
          sdkClient={sdk.client}
          sdkUrl={sdk.url}
        />
      </Show>

      {/* Run menu */}
      <Show when={showRunMenu() && selectedBpId()}>
        <RunMenu
          blueprint={allBlueprints().find((b) => b.id === selectedBpId())!}
          hasCurrentSession={!!params.id}
          onRun={runBlueprint}
          onClose={() => setShowRunMenu(false)}
        />
      </Show>
    </div>
  )
}
