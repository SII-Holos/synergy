import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
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

const BP_STATUS_ICONS: Record<string, string> = {
  draft: "file-pen",
  ready: "circle-check",
  archived: "archive",
}

function isActiveLoop(s: LoopStatus) {
  return s === "running" || s === "waiting" || s === "auditing"
}

// ---------------------------------------------------------------------------
// Run modal
// ---------------------------------------------------------------------------

function RunModal(props: {
  blueprint: BlueprintMetaInfo
  sessionID: string
  onRun: (mode: "current" | "new" | "worktree", firstPrompt: string) => void
  onClose: () => void
}) {
  const [mode, setMode] = createSignal<"current" | "new" | "worktree">("current")
  const [firstPrompt, setFirstPrompt] = createSignal("")

  return (
    <div class="bp-modal-backdrop fixed inset-0 z-50 flex items-center justify-center" onClick={props.onClose}>
      <div class="bp-card mx-4 w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h3 class="text-13-medium text-text-strong mb-4">Run Blueprint: {props.blueprint.title || "Untitled"}</h3>

        <div class="space-y-2 mb-4">
          <span class="text-11-medium text-text-weak">Run mode</span>
          <div class="flex gap-2">
            <button
              type="button"
              class="bp-card px-3 py-1.5 text-11-medium transition-colors"
              classList={{ "bp-card-active": mode() === "current" }}
              onClick={() => setMode("current")}
            >
              Current session
            </button>
            <button
              type="button"
              class="bp-card px-3 py-1.5 text-11-medium transition-colors"
              classList={{ "bp-card-active": mode() === "new" }}
              onClick={() => setMode("new")}
            >
              New session
            </button>
            <button
              type="button"
              class="bp-card px-3 py-1.5 text-11-medium transition-colors"
              classList={{ "bp-card-active": mode() === "worktree" }}
              onClick={() => setMode("worktree")}
            >
              New worktree
            </button>
          </div>
        </div>

        <div class="space-y-1.5 mb-5">
          <span class="text-11-medium text-text-weak">First prompt (optional)</span>
          <textarea
            class="bp-search w-full resize-none rounded-lg px-3 py-2 text-12-regular text-text-base placeholder:text-text-weak border border-border-weaker-base"
            rows={3}
            placeholder="Enter the initial prompt to send..."
            value={firstPrompt()}
            onInput={(e) => setFirstPrompt(e.currentTarget.value)}
          />
        </div>

        <div class="flex gap-2 justify-end">
          <button
            type="button"
            class="bp-card px-4 py-1.5 text-11-medium text-text-weak transition-colors hover:text-text-base"
            onClick={props.onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="bp-card bp-card-active px-4 py-1.5 text-11-semibold text-text-interactive-base transition-colors"
            onClick={() => props.onRun(mode(), firstPrompt())}
          >
            Run
          </button>
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
  loops: () => Map<string, BlueprintLoopInfo[]>
  onBack: () => void
  onRun: () => void
  onConvertToNote: () => void
  onDelete: () => void
  sdkClient: ReturnType<typeof import("@ericsanchezok/synergy-sdk/client").createSynergyClient>
  sdkUrl: string
}) {
  const bpMeta = createMemo(() => props.allBps().find((b) => b.id === props.id))
  const noteLoops = createMemo(() => props.loops().get(props.id) ?? [])
  const params = useParams()

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
        <div class="shrink-0 border-b border-border-weak-base bg-surface-raised-base/92 px-4 py-3">
          <div class="flex items-center gap-2 rounded-[1.15rem] bg-surface-inset-base/42 px-2.5 py-2">
            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha text-icon-weak shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
              onClick={props.onBack}
              title="Back to list"
            >
              <Icon name="arrow-left" size="normal" />
            </button>

            <div class="min-w-0 flex-1 rounded-[0.95rem] bg-surface-raised-base/92 px-3.5 py-2">
              <span class="text-14-medium tracking-tight text-text-strong truncate block">
                {bp()!.title || "Untitled Blueprint"}
              </span>
            </div>

            <span class={`bp-status bp-status-${bp()!.blueprint?.status || "draft"} shrink-0 text-11-medium`}>
              <Icon
                name={BP_STATUS_ICONS[bp()!.blueprint?.status ?? "draft"] ?? "circle"}
                size="small"
                class="size-3"
              />
              {bp()!.blueprint?.status || "draft"}
            </span>

            <button
              type="button"
              class="bp-card bp-card-active px-2.5 py-1.5 text-11-medium text-text-interactive-base transition-colors flex items-center gap-1"
              onClick={props.onRun}
              title="Run Blueprint"
              disabled={(bp()!.blueprint?.status ?? "draft") !== "ready"}
            >
              <Icon name="zap" size="small" class="size-3" />
              <span>Run</span>
            </button>

            <button
              type="button"
              class="bp-card px-2.5 py-1.5 text-11-medium text-text-weak transition-colors hover:text-text-base flex items-center gap-1"
              onClick={props.onConvertToNote}
              title="Convert to Note"
            >
              <Icon name="notebook-pen" size="small" class="size-3" />
              <span>To Note</span>
            </button>

            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-full border border-border-weak-base bg-surface-raised-stronger-non-alpha text-icon-weak shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-text-diff-delete-base"
              onClick={props.onDelete}
              title="Delete"
            >
              <Icon name="trash-2" size="small" />
            </button>
          </div>
        </div>

        {/* Meta section */}
        <div class="shrink-0 border-b border-border-weak-base bg-surface-raised-base/88 px-4 py-3">
          <div class="flex items-center gap-3 text-11-regular text-text-weak">
            <Show when={bp()!.blueprint?.defaultAgent}>
              <span>
                Agent: <span class="text-text-base">{bp()!.blueprint!.defaultAgent}</span>
              </span>
            </Show>
            <span>Runs: {bp()!.blueprint?.runCount ?? 0}</span>
            <Show when={bp()!.blueprint?.lastRunAt}>
              <span>Last run: {relativeTime(bp()!.blueprint!.lastRunAt!)}</span>
            </Show>
            <Show when={bp()!.blueprint?.activeLoopID}>
              <span class="flex items-center gap-1">
                <div class="size-1.5 rounded-full bg-text-diff-add-base" />
                Active loop
              </span>
            </Show>
          </div>
        </div>

        {/* Loop history */}
        <Show when={noteLoops().length > 0}>
          <div class="shrink-0 border-b border-border-weak-base px-4 py-3">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-11-semibold text-text-base">Loop History</span>
              <span class="text-10-regular text-text-weak">{noteLoops().length}</span>
            </div>
            <div class="space-y-1.5">
              <For each={noteLoops().slice(0, 10)}>
                {(loop) => {
                  const [activity] = createResource(
                    () => loop.id,
                    (id) =>
                      props.sdkClient.blueprint.loop
                        .activity({ id })
                        .then((r) => r.data)
                        .catch(() => undefined),
                  )
                  const isActive = isActiveLoop(loop.status)
                  return (
                    <div class="bp-card bp-card-active px-3 py-2 flex items-center gap-2 text-10-regular">
                      <Icon
                        name={LOOP_STATUS_ICONS[loop.status]}
                        size="small"
                        class={`text-icon-weak shrink-0 ${isActive ? "text-text-interactive-base" : ""}`}
                      />
                      <span class="truncate flex-1 text-text-base">{loop.title}</span>
                      <span class={`bp-loop-status bp-loop-${loop.status} shrink-0`}>{loop.status}</span>
                      <Show when={loop.sessionID}>
                        <button
                          type="button"
                          class="bp-card px-1.5 py-0.5 text-10-medium text-text-interactive-base transition-colors hover:bg-surface-interactive-base/8"
                          onClick={() => {
                            window.open(`/${params.dir}/session/${loop.sessionID}`, "_self")
                          }}
                        >
                          Open
                        </button>
                      </Show>
                      <Show when={loop.runMode}>
                        <span class="text-text-weaker">{loop.runMode}</span>
                      </Show>
                      <Show when={activity()}>
                        <span class="text-text-weaker">
                          {(activity() as BlueprintLoopActivity).stepCount}s /
                          {(activity() as BlueprintLoopActivity).messageCount}m
                        </span>
                      </Show>
                      <span class="text-text-weaker">{relativeTime(loop.time.updated)}</span>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Editor */}
        <div class="flex-1 min-h-0">
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

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function BlueprintPanel() {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))

  const [view, setView] = createSignal<"list" | "detail">("list")
  const [selectedBpId, setSelectedBpId] = createSignal<string | null>(null)
  const [selectedBpDir, setSelectedBpDir] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal("")
  const [showRunModal, setShowRunModal] = createSignal(false)

  // Fetch all notes, filter blueprints
  const [blueprintMeta, { refetch: refetchNotes }] = createResource(
    () => ({ dir: directory(), ver: globalSync.noteVersion() }),
    async ({ dir }) => {
      if (!dir) return [] as BlueprintMetaInfo[]
      const result = await sdk.client.note.listMeta({ directory: dir })
      const blueprints: BlueprintMetaInfo[] = []
      for (const g of result.data ?? []) {
        for (const n of g.notes) {
          if (n.kind === "blueprint") {
            blueprints.push(n as BlueprintMetaInfo)
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

  async function runBlueprint(mode: "current" | "new" | "worktree", firstPrompt: string) {
    const bp = allBlueprints().find((b) => b.id === selectedBpId())
    if (!bp) return
    const dir = directory()
    if (!dir) return

    try {
      const sessionID = params.id
      if (!sessionID) {
        console.error("No session ID available")
        return
      }
      await sdk.client.blueprint.loop.create({
        blueprintLoopCreateInput: {
          noteID: bp.id,
          title: bp.title || "Blueprint run",
          description: bp.blueprint?.description,
          sessionID,
          runMode: mode,
          firstPrompt: firstPrompt || undefined,
        },
      })
      setShowRunModal(false)
      await refetchLoops()
      await refetchNotes()
    } catch (e) {
      console.error("Failed to create loop", e)
    }
  }

  async function convertToNote() {
    const bp = allBlueprints().find((b) => b.id === selectedBpId())
    if (!bp) return
    const dir = selectedBpDir() ?? directory()
    if (!dir) return

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
              <button
                type="button"
                class="flex items-center justify-center size-6 rounded-md text-icon-weak hover:text-icon-base"
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

              {/* Ready */}
              <Show when={readyBps().length > 0}>
                <div class="mb-4">
                  <div class="flex items-center gap-2 mb-2.5 px-0.5">
                    <span class="text-11-semibold text-text-base">Ready</span>
                    <span class="text-10-regular text-text-weak">{readyBps().length}</span>
                  </div>
                  <div
                    class="grid gap-2.5"
                    style="grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr))"
                  >
                    <For each={readyBps()}>
                      {(bp) => {
                        const bpLoops = loopsByNote().get(bp.id) ?? []
                        const hasActive = bpLoops.some((l) => isActiveLoop(l.status))
                        return (
                          <button
                            type="button"
                            class="bp-card group overflow-hidden flex flex-col text-left cursor-pointer"
                            classList={{ "bp-card-active": hasActive }}
                            draggable={true}
                            onDragStart={(e) => attachBlueprintDragData(e, bp)}
                            onClick={() => openDetail(bp.id, directory()!)}
                          >
                            <div class="px-3.5 pt-3 pb-2 flex items-start gap-2">
                              <div class="min-w-0 flex-1">
                                <span class="block text-12-medium text-text-strong truncate">
                                  {bp.title || "Untitled"}
                                </span>
                                <Show when={bp.blueprint?.description}>
                                  <p class="text-10-regular text-text-weak line-clamp-2 mt-0.5">
                                    {bp.blueprint!.description}
                                  </p>
                                </Show>
                              </div>
                              <span class="bp-status bp-status-ready shrink-0">
                                <Icon name="circle-check" size="small" class="size-2.5" />
                                ready
                              </span>
                            </div>
                            <div class="px-3.5 pb-2.5 mt-auto">
                              <div class="flex items-center gap-2 text-10-regular text-text-weaker">
                                <Show when={bp.blueprint?.defaultAgent}>
                                  <span class="truncate">{bp.blueprint!.defaultAgent}</span>
                                </Show>
                                <span class="flex-1" />
                                <Show when={(bp.blueprint?.runCount ?? 0) > 0}>
                                  <span>{bp.blueprint!.runCount} runs</span>
                                </Show>
                                <span>{relativeTime(bp.blueprint?.lastRunAt ?? bp.time.updated)}</span>
                              </div>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Draft */}
              <Show when={draftBps().length > 0}>
                <div class="mb-4">
                  <div class="flex items-center gap-2 mb-2.5 px-0.5">
                    <span class="text-11-semibold text-text-base">Draft</span>
                    <span class="text-10-regular text-text-weak">{draftBps().length}</span>
                  </div>
                  <div
                    class="grid gap-2.5"
                    style="grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr))"
                  >
                    <For each={draftBps()}>
                      {(bp) => (
                        <button
                          type="button"
                          class="bp-card group overflow-hidden flex flex-col text-left cursor-pointer"
                          draggable={true}
                          onDragStart={(e) => attachBlueprintDragData(e, bp)}
                          onClick={() => openDetail(bp.id, directory()!)}
                        >
                          <div class="px-3.5 pt-3 pb-2 flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <span class="block text-12-medium text-text-strong truncate">
                                {bp.title || "Untitled"}
                              </span>
                              <Show when={bp.blueprint?.description}>
                                <p class="text-10-regular text-text-weak line-clamp-2 mt-0.5">
                                  {bp.blueprint!.description}
                                </p>
                              </Show>
                            </div>
                            <span class="bp-status bp-status-draft shrink-0">
                              <Icon name="file-pen" size="small" class="size-2.5" />
                              draft
                            </span>
                          </div>
                          <div class="px-3.5 pb-2.5 mt-auto">
                            <div class="flex items-center gap-2 text-10-regular text-text-weaker">
                              <span class="flex-1" />
                              <span>{relativeTime(bp.time.updated)}</span>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Archived */}
              <Show when={archivedBps().length > 0}>
                <div class="mb-4">
                  <div class="flex items-center gap-2 mb-2.5 px-0.5">
                    <span class="text-11-semibold text-text-base">Archived</span>
                    <span class="text-10-regular text-text-weak">{archivedBps().length}</span>
                  </div>
                  <div
                    class="grid gap-2.5"
                    style="grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr))"
                  >
                    <For each={archivedBps()}>
                      {(bp) => (
                        <button
                          type="button"
                          class="bp-card group overflow-hidden flex flex-col text-left cursor-pointer opacity-70"
                          draggable={true}
                          onDragStart={(e) => attachBlueprintDragData(e, bp)}
                          onClick={() => openDetail(bp.id, directory()!)}
                        >
                          <div class="px-3.5 pt-3 pb-2 flex items-start gap-2">
                            <div class="min-w-0 flex-1">
                              <span class="block text-12-medium text-text-strong truncate">
                                {bp.title || "Untitled"}
                              </span>
                              <Show when={bp.blueprint?.description}>
                                <p class="text-10-regular text-text-weak line-clamp-2 mt-0.5">
                                  {bp.blueprint!.description}
                                </p>
                              </Show>
                            </div>
                            <span class="bp-status bp-status-archived shrink-0">
                              <Icon name="archive" size="small" class="size-2.5" />
                              archived
                            </span>
                          </div>
                          <div class="px-3.5 pb-2.5 mt-auto">
                            <div class="flex items-center gap-2 text-10-regular text-text-weaker">
                              <span class="flex-1" />
                              <span>{relativeTime(bp.time.updated)}</span>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Empty state */}
              <Show when={allBlueprints().length === 0 && !blueprintMeta.loading}>
                <div class="flex flex-col items-center justify-center py-16 gap-3">
                  <Icon name="workflow" size="large" class="text-icon-weak" />
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
          loops={loopsByNote}
          onBack={() => {
            setView("list")
            void refetchNotes()
            void refetchLoops()
          }}
          onRun={() => setShowRunModal(true)}
          onConvertToNote={convertToNote}
          onDelete={deleteBlueprint}
          sdkClient={sdk.client}
          sdkUrl={sdk.url}
        />
      </Show>

      {/* Run modal */}
      <Show when={showRunModal() && selectedBpId()}>
        <RunModal
          blueprint={allBlueprints().find((b) => b.id === selectedBpId())!}
          sessionID={params.id ?? ""}
          onRun={(mode, prompt) => runBlueprint(mode, prompt)}
          onClose={() => setShowRunModal(false)}
        />
      </Show>
    </div>
  )
}
