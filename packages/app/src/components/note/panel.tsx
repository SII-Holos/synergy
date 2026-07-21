import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { List } from "@ericsanchezok/synergy-ui/list"
import { createMemo, createResource, createSignal, For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import type { Editor } from "@tiptap/core"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useData } from "@ericsanchezok/synergy-ui/context"

import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { TIPTAP_STYLES, DocumentEditorCore } from "@/components/note/document-editor-core"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { archiveNoteConfirm, unarchiveNoteConfirm, deleteArchivedNoteConfirm } from "@/components/dialog/confirm-copy"
import { SelectionCheckbox } from "@/components/library/shared"
import type {
  BlueprintLoopInfo,
  Event as SynergyEvent,
  NoteInfo,
  NoteMetaInfo,
  NoteMetaScopeGroup,
  NotePatchInput,
} from "@ericsanchezok/synergy-sdk/client"
import { getScopeLabel, HOME_SCOPE_KEY } from "@/utils/scope"
import { assetHttpUrl } from "@/utils/asset-url"
import { useLocale } from "@/context/locale"
import { useLingui } from "@lingui/solid"
import { requestErrorMessage } from "@/utils/error"
import { relativeTime } from "@/utils/time"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import {
  activeBlueprintLoop,
  blueprintExecutionControlProfile,
  blueprintSessionWorkspaceSelection,
  canCreateBlueprintWorktree,
  canRunBlueprintInCurrentSession,
  isActiveBlueprintLoopStatus,
  type BlueprintRunMode,
} from "@/components/note/blueprint-run-session"
import {
  clearCapturedDirty,
  cloneDirtyRevisions,
  dirtyConflicts,
  EMPTY_DIRTY_REVISIONS,
  hasDirtyFields,
  noteChangedFields,
  patchBlueprintLoops,
  patchNoteGroups,
  patchNoteGroupsMany,
  removeNotesFromGroups,
  shouldReplaceEditorContent,
  type NoteChangedField,
  type NoteDirtyField,
  type NoteDirtyRevisions,
} from "@/components/note/note-sync"
import { note as N } from "@/locales/messages"
import "./panel.css"

type LoopStatus = BlueprintLoopInfo["status"]

type NoteCardInfo = NoteMetaInfo & {
  kind?: "note" | "blueprint"
}

type BlueprintVisualState = {
  label: string
  detail: string
  tone: "idle" | "running" | "waiting" | "auditing" | "failed" | "completed"
  icon: ReturnType<typeof getSemanticIcon>
}

function isBlueprintNote(note: { kind?: string; blueprint?: unknown }) {
  return note.kind === "blueprint"
}

function getLoopLabel(lingui: ReturnType<typeof useLingui>, status: LoopStatus) {
  if (status === "armed") return lingui._({ id: N.runQueued.id, message: N.runQueued.message })
  if (status === "running") return lingui._({ id: N.running.id, message: N.running.message })
  if (status === "waiting") return lingui._({ id: N.needsInput.id, message: N.needsInput.message })
  if (status === "auditing") return lingui._({ id: N.reviewing.id, message: N.reviewing.message })
  if (status === "completed") return lingui._({ id: N.completed.id, message: N.completed.message })
  if (status === "failed") return lingui._({ id: N.failed.id, message: N.failed.message })
  return lingui._({ id: N.cancelled.id, message: N.cancelled.message })
}

function getLoopTone(status: LoopStatus): BlueprintVisualState["tone"] {
  if (status === "armed" || status === "running") return "running"
  if (status === "waiting") return "waiting"
  if (status === "auditing") return "auditing"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  return "idle"
}

function getRunModeLabel(lingui: ReturnType<typeof useLingui>, mode?: BlueprintLoopInfo["runMode"]) {
  if (mode === "current") return lingui._({ id: N.sessionRun.id, message: N.sessionRun.message })
  if (mode === "new") return lingui._({ id: N.newSession.id, message: N.newSession.message })
  if (mode === "worktree") return lingui._({ id: N.worktreeRun.id, message: N.worktreeRun.message })
  return lingui._({ id: N.activeRun.id, message: N.activeRun.message })
}

function getBlueprintVisualState(
  lingui: ReturnType<typeof useLingui>,
  note: NoteCardInfo | NoteInfo,
  loops: BlueprintLoopInfo[] = [],
): BlueprintVisualState {
  const active = activeBlueprintLoop(note, loops)
  if (active) {
    const status = active.status as LoopStatus
    const runMode = "runMode" in active ? active.runMode : undefined
    return {
      label: getLoopLabel(lingui, status),
      detail: getRunModeLabel(lingui, runMode),
      tone: getLoopTone(status),
      icon:
        status === "auditing"
          ? getSemanticIcon("command.audit")
          : status === "waiting"
            ? getSemanticIcon("session.waiting")
            : getSemanticIcon("command.start"),
    }
  }
  const latest = loops[0]
  if (latest?.status === "failed") {
    return {
      label: lingui._({ id: N.runFailed.id, message: N.runFailed.message }),
      detail: lingui._({ id: N.lastRunFailed.id, message: N.lastRunFailed.message }),
      tone: "failed",
      icon: getSemanticIcon("state.error"),
    }
  }
  return {
    label: lingui._({ id: N.blueprint.id, message: N.blueprint.message }),
    detail: lingui._({ id: N.noActiveRun.id, message: N.noActiveRun.message }),
    tone: "idle",
    icon: getSemanticIcon("blueprint.main"),
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
    "flex items-center gap-2 rounded-xl border border-border-weak-base bg-surface-raised-base/95 px-3 py-2 text-12-medium text-text-base shadow-lg"
  dragImage.style.position = "absolute"
  dragImage.style.top = "-1000px"
  dragImage.textContent = title
  document.body.appendChild(dragImage)
  e.dataTransfer!.setDragImage(dragImage, 0, 16)
  setTimeout(() => document.body.removeChild(dragImage), 0)
}

type NoteCardVariant = "compact" | "balanced" | "featured"
type NoteKindFilter = "all" | "note" | "blueprint"

function NoteCard(props: {
  note: NoteCardInfo
  originName?: string
  variant?: NoteCardVariant
  loops?: BlueprintLoopInfo[]
  onClick: () => void
  selecting?: boolean
  selected?: boolean
  onToggleSelect?: (id: string, shiftKey?: boolean) => void
  lingui: ReturnType<typeof useLingui>
}) {
  const { fmt } = useLocale()
  const previewHtml = createMemo(() => props.note.previewHtml ?? null)
  const searchPreview = createMemo(() => props.note.searchText ?? "")
  const hasContent = createMemo(() => (previewHtml() ?? searchPreview()).length > 0)
  const variant = createMemo(() => props.variant ?? "balanced")
  const isBlueprint = createMemo(() => isBlueprintNote(props.note))
  const blueprintState = createMemo(() => getBlueprintVisualState(props.lingui, props.note, props.loops ?? []))
  const cardHeight = createMemo(() => {
    if (variant() === "compact") return "h-[260px]"
    if (variant() === "featured") return "h-[370px]"
    return "h-[320px]"
  })

  return (
    <button
      type="button"
      class={`group note-card relative flex w-full ${cardHeight()} flex-col overflow-hidden rounded-[0.95rem] border border-border-weaker-base bg-surface-raised-base/80 text-left hover:border-border-weak-hover hover:bg-surface-raised-base-hover active:scale-[0.99] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background-base`}
      classList={{
        "note-card--blueprint": isBlueprint(),
        [`note-card--blueprint-${blueprintState().tone}`]: isBlueprint(),
      }}
      draggable={!props.selecting}
      onDragStart={(e) => {
        if (!props.selecting) attachNoteDragData(e, props.note)
      }}
      onClick={(e) => {
        if (props.selecting && props.onToggleSelect) {
          props.onToggleSelect(props.note.id, e.shiftKey)
        } else {
          props.onClick()
        }
      }}
    >
      <Show when={props.selecting && props.onToggleSelect}>
        <div class="absolute right-2 top-2 z-10" onClick={(e) => e.stopPropagation()}>
          <SelectionCheckbox selected={props.selected ?? false} />
        </div>
      </Show>
      <Show when={props.originName}>
        <span class="sr-only">
          {props.lingui._({
            id: N.fromOrigin.id,
            message: N.fromOrigin.message,
            values: { name: props.originName ?? "" },
          })}
        </span>
      </Show>

      <Show when={isBlueprint()}>
        <div class={`note-blueprint-card-header note-blueprint-card-header--${blueprintState().tone}`}>
          <span class="note-blueprint-card-kicker">
            <Icon name={getSemanticIcon("blueprint.main")} size="small" class="size-3.5" />
            {props.lingui._({ id: N.blueprint.id, message: N.blueprint.message })}
          </span>
          <span class={`note-card-status note-card-status--${blueprintState().tone}`}>
            <Icon name={blueprintState().icon} size="small" class="size-3" />
            {blueprintState().label}
          </span>
        </div>
      </Show>

      <div class={isBlueprint() ? "px-3.5 pt-3" : "px-3.5 pt-3.5"}>
        <span
          classList={{
            "line-clamp-2 text-text-strong": true,
            "text-12-medium": variant() !== "featured",
            "text-14-medium tracking-tight": variant() === "featured",
          }}
        >
          {props.note.title || props.lingui._({ id: N.untitled.id, message: N.untitled.message })}
        </span>
      </div>

      <Show
        when={hasContent()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-text-weaker opacity-35">
            <Icon name={getSemanticIcon("notes.main")} size="large" />
          </div>
        }
      >
        <div class="note-card-preview min-h-0 flex-1 overflow-hidden px-3.5 pt-2">
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

      <div class="note-card-footer mt-auto shrink-0 px-3.5 py-2.5">
        <Show
          when={isBlueprint()}
          fallback={
            <div class="flex items-center gap-2">
              <Show when={props.originName}>
                <span class="note-card-origin">
                  <Icon name={getSemanticIcon("notes.folder")} class="size-3 shrink-0" />
                  <span class="truncate">
                    {props.lingui._({
                      id: N.fromOrigin.id,
                      message: N.fromOrigin.message,
                      values: { name: props.originName ?? "" },
                    })}
                  </span>
                </span>
              </Show>
              <Show when={props.note.pinned}>
                <span class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-raised-stronger-non-alpha text-text-weak">
                  <Icon name={getSemanticIcon("notes.pin")} size="small" class="size-3" />
                </span>
              </Show>
              <span class="flex-1" />
              <span class="text-11-regular text-text-weak">{relativeTime(fmt, props.note.time.updated)}</span>
            </div>
          }
        >
          <div class="flex items-center gap-2">
            <span class="min-w-0 truncate text-10-medium uppercase tracking-[0.08em] text-text-weaker">
              {props.lingui._({ id: N.runHistory.id, message: N.runHistory.message })}
            </span>
            <span class="min-w-0 flex-1 truncate text-10-regular text-text-weaker">{blueprintState().detail}</span>
            <Show when={props.note.pinned}>
              <Icon name={getSemanticIcon("notes.pin")} size="small" class="size-3 shrink-0 text-text-weak" />
            </Show>
          </div>
          <div class="mt-2 flex items-center gap-2 text-11-regular text-text-weak">
            <Show when={props.originName}>
              <span class="note-card-origin">
                <Icon name={getSemanticIcon("notes.folder")} class="size-3 shrink-0" />
                <span class="truncate">
                  {props.lingui._({
                    id: N.fromOrigin.id,
                    message: N.fromOrigin.message,
                    values: { name: props.originName ?? "" },
                  })}
                </span>
              </span>
            </Show>
            <span class="truncate">
              {getRunCount(props.note, props.loops ?? []) > 0
                ? props.lingui._({
                    id: N.runsCount.id,
                    message: N.runsCount.message,
                    values: { count: getRunCount(props.note, props.loops ?? []) },
                  })
                : props.lingui._({ id: N.noRunsYet.id, message: N.noRunsYet.message })}
            </span>
            <span class="flex-1" />
            <span class="shrink-0">{relativeTime(fmt, getBlueprintActivityTime(props.note, props.loops ?? []))}</span>
          </div>
        </Show>
      </div>
    </button>
  )
}

/** Skeleton placeholder matching NoteCard shape, shown during list loading */
function NoteCardSkeleton() {
  return (
    <div class="flex w-full h-[320px] flex-col overflow-hidden rounded-[0.95rem] border border-border-weaker-base bg-surface-raised-base/70 animate-pulse">
      <div class="px-3.5 pt-3.5 space-y-1.5">
        <div class="h-3 w-3/4 rounded bg-surface-inset-base/70" />
        <div class="h-3 w-1/2 rounded bg-surface-inset-base/70" />
      </div>
      <div class="flex-1 px-3.5 pt-2 space-y-1">
        <div class="h-2 w-full rounded bg-surface-inset-base/70" />
        <div class="h-2 w-5/6 rounded bg-surface-inset-base/70" />
        <div class="h-2 w-2/3 rounded bg-surface-inset-base/70" />
      </div>
      <div class="note-card-footer shrink-0 px-3.5 py-2.5">
        <div class="ml-auto h-3 w-1/4 rounded bg-surface-inset-base/70" />
      </div>
    </div>
  )
}

function RunMenu(props: {
  title: string
  canRunInCurrentSession: boolean
  canCreateWorktree: boolean
  onRun: (mode: BlueprintRunMode, model?: { providerID: string; modelID: string }) => void
  onClose: () => void
}) {
  const globalSync = useGlobalSync()
  const lingui = useLingui()
  const [level, setLevel] = createSignal<"mode" | "model">("mode")
  const [selectedMode, setSelectedMode] = createSignal<BlueprintRunMode | null>(null)
  const [selectedModelValue, setSelectedModelValue] = createSignal("")
  const [pickerOpen, setPickerOpen] = createSignal(false)

  type ModelOption =
    | { kind: "fallback"; key: string; label: string; description: string; value: string }
    | {
        kind: "model"
        key: string
        label: string
        description: string
        value: string
        providerID: string
        modelID: string
      }

  const providerModels = createMemo<ModelOption[]>(() => {
    const data = globalSync.data.provider
    const list: ModelOption[] = []
    for (const provider of data.all) {
      if (!data.connected.includes(provider.id)) continue
      if (data.runtimeAvailability?.[provider.id]?.available === false) continue
      for (const [modelId, model] of Object.entries(provider.models)) {
        list.push({
          kind: "model",
          key: `${provider.id}/${modelId}`,
          label: model.name,
          description: provider.name,
          value: `${provider.id}/${modelId}`,
          providerID: provider.id,
          modelID: modelId,
        })
      }
    }
    list.sort((a, b) => {
      if (a.description !== b.description) return a.description.localeCompare(b.description)
      return a.label.localeCompare(b.label)
    })
    return list
  })

  const modelOptions = createMemo<ModelOption[]>(() => {
    const fallback: ModelOption = {
      kind: "fallback",
      key: "fallback",
      label: lingui._(N.useFallback),
      description: lingui._(N.useFallbackDesc),
      value: "",
    }
    return [fallback, ...providerModels()]
  })

  const currentModelOption = createMemo(() => {
    return modelOptions().find((o) => o.value === selectedModelValue()) ?? modelOptions()[0]
  })

  function selectModelOption(option: ModelOption | undefined) {
    if (!option) return
    setSelectedModelValue(option.value)
    setPickerOpen(false)
  }

  function handleRun() {
    const mode = selectedMode()
    if (!mode) return
    const opt = currentModelOption()
    if (opt && opt.kind === "model") {
      props.onRun(mode, { providerID: opt.providerID, modelID: opt.modelID })
    } else {
      props.onRun(mode)
    }
  }

  const options = [
    {
      mode: "current" as const,
      icon: getSemanticIcon("prompt.blueprintStart"),
      title: lingui._(N.currentSession),
      description: props.canRunInCurrentSession ? lingui._(N.currentSessionDesc) : lingui._(N.currentSessionHint),
      disabled: !props.canRunInCurrentSession,
    },
    {
      mode: "new" as const,
      icon: getSemanticIcon("session.new"),
      title: lingui._(N.newSessionRun),
      description: lingui._(N.newSessionDesc),
      disabled: false,
    },
    {
      mode: "worktree" as const,
      icon: getSemanticIcon("workspace.worktree"),
      title: lingui._(N.newWorktreeSession),
      description: props.canCreateWorktree ? lingui._(N.worktreeDesc) : lingui._(N.worktreeHint),
      disabled: !props.canCreateWorktree,
    },
  ]

  const modeLabel = createMemo(() => {
    const m = selectedMode()
    if (!m) return ""
    if (m === "current") return lingui._(N.currentSession)
    if (m === "new") return lingui._(N.newSessionRun)
    return lingui._(N.newWorktreeSession)
  })

  function resolveGroup(option: ModelOption) {
    if (option.kind === "fallback") return "Default"
    return option.description
  }

  function sortModelGroups(
    a: { category: string; items: ModelOption[] },
    b: { category: string; items: ModelOption[] },
  ) {
    if (a.category === "Default") return -1
    if (b.category === "Default") return 1
    return a.category.localeCompare(b.category)
  }

  return (
    <div class="note-run-menu absolute right-4 top-[3.75rem] z-40 w-[min(22rem,calc(100%-2rem))]">
      <Show when={level() === "mode"} fallback={null}>
        <div class="note-run-menu-header">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <h3 class="text-13-medium text-text-strong">{lingui._(N.runBlueprint)}</h3>
              <p class="mt-1 line-clamp-2 text-11-regular text-text-weak">{props.title || lingui._(N.untitled)}</p>
            </div>
            <button
              type="button"
              class="note-run-menu-close"
              onClick={props.onClose}
              title={lingui._(N.close)}
              aria-label={lingui._(N.closeRunMenu)}
            >
              <Icon name={getSemanticIcon("action.close")} size="small" class="size-3" />
            </button>
          </div>
        </div>
        <div class="note-run-option-list">
          <For each={options}>
            {(option) => (
              <button
                type="button"
                class="note-run-option"
                classList={{ "note-run-option--disabled": option.disabled }}
                disabled={option.disabled}
                onClick={() => {
                  setSelectedMode(option.mode)
                  setLevel("model")
                }}
              >
                <span class="note-run-option-icon">
                  <Icon name={option.icon} size="small" class="size-3.5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-12-medium text-text-strong">{option.title}</span>
                  <span class="mt-0.5 block text-10-regular leading-4 text-text-weak">{option.description}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={level() === "model"}>
        <div class="note-run-menu-header">
          <div class="flex items-start gap-2">
            <button
              type="button"
              class="note-run-menu-back"
              onClick={() => setLevel("mode")}
              title={lingui._(N.back)}
              aria-label={lingui._(N.backToSession)}
            >
              <Icon name={getSemanticIcon("navigation.back")} size="small" class="size-3.5" />
            </button>
            <div class="min-w-0 flex-1">
              <h3 class="text-13-medium text-text-strong">{lingui._(N.runBlueprint)}</h3>
              <p class="mt-1 line-clamp-2 text-11-regular text-text-weak">
                {modeLabel()}
                {lingui._(N.separator)}
                {props.title || lingui._(N.untitled)}
              </p>
            </div>
            <button
              type="button"
              class="note-run-menu-close"
              onClick={props.onClose}
              title={lingui._(N.close)}
              aria-label={lingui._(N.closeRunMenu)}
            >
              <Icon name={getSemanticIcon("action.close")} size="small" class="size-3" />
            </button>
          </div>
        </div>
        <div class="note-run-model-body">
          <div class="note-run-model-copy">
            <span class="note-run-model-label">{lingui._(N.model)}</span>
            <span class="note-run-model-description">{lingui._(N.modelChooseHelp)}</span>
          </div>
          <KobaltePopover open={pickerOpen()} onOpenChange={setPickerOpen} placement="bottom-end" gutter={8}>
            <KobaltePopover.Trigger
              type="button"
              class="settings-model-trigger note-run-model-trigger"
              aria-label={lingui._(N.chooseModel)}
            >
              <span class="settings-model-trigger-text">
                <span class="settings-model-trigger-title">{currentModelOption()?.label}</span>
                <span class="settings-model-trigger-detail">{currentModelOption()?.description}</span>
              </span>
              <Icon name={getSemanticIcon("navigation.collapse")} size="small" class="settings-model-trigger-icon" />
            </KobaltePopover.Trigger>
            <KobaltePopover.Portal>
              <KobaltePopover.Content class="settings-model-picker-popover note-run-model-picker flex flex-col border border-border-base bg-surface-raised-stronger-non-alpha shadow-lg outline-none overflow-hidden">
                <KobaltePopover.Title class="sr-only">{lingui._(N.selectModel)}</KobaltePopover.Title>
                <List<ModelOption>
                  class="settings-model-picker-list"
                  search={{ placeholder: lingui._(N.searchModels), autofocus: true }}
                  emptyMessage={lingui._(N.noModelResults)}
                  key={(option) => option.key}
                  items={modelOptions}
                  current={currentModelOption()}
                  filterKeys={["label", "description", "value"]}
                  groupBy={resolveGroup}
                  sortGroupsBy={sortModelGroups}
                  onSelect={selectModelOption}
                >
                  {(option) => (
                    <div class="settings-model-option">
                      <span class="settings-model-option-title">{option.label}</span>
                      <span class="settings-model-option-detail">{option.description}</span>
                    </div>
                  )}
                </List>
              </KobaltePopover.Content>
            </KobaltePopover.Portal>
          </KobaltePopover>
          <button type="button" class="note-run-model-run" onClick={handleRun}>
            <Icon name={getSemanticIcon("prompt.blueprintStart")} size="small" class="size-3.5" />
            {lingui._(N.runWithSelectedModel)}
          </button>
        </div>
      </Show>
    </div>
  )
}

type DisplayGroup = NoteMetaScopeGroup & {
  name: string
  directory: string
  isCurrent: boolean
  archived?: boolean
}

function ScopeSection(props: {
  lingui: ReturnType<typeof useLingui>
  group: DisplayGroup
  expanded: boolean
  loopsByNote: Map<string, BlueprintLoopInfo[]>
  onToggle: () => void
  onOpenNote: (id: string) => void
  onCreateNote: () => void
  scopeLookup: Map<string, { name: string; directory: string }>
  selecting?: boolean
  selectedNotes?: Set<string>
  onToggleSelect?: (id: string, shiftKey?: boolean) => void
}) {
  const { fmt } = useLocale()
  const [columns, setColumns] = createSignal(2)
  const latestUpdated = createMemo(() => props.group.notes[0]?.time.updated)
  const noteCountLabel = createMemo(() =>
    props.lingui._({
      id: N.noteCountLabel.id,
      message: N.noteCountLabel.message,
      values: { count: props.group.notes.length },
    }),
  )
  const shelfNotes = createMemo(() => {
    void props.selecting
    void props.selectedNotes?.size
    return props.group.notes.slice(0, columns())
  })
  const hasMore = createMemo(() => props.group.notes.length > columns())

  let sectionRef!: HTMLElement

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      const cols = w < 380 ? 1 : w < 660 ? 2 : 3
      setColumns(cols)
    })
    ro.observe(sectionRef)
    onCleanup(() => ro.disconnect())
  })

  function getOriginName(note: NoteMetaInfo): string | undefined {
    if (props.group.scopeType !== "home") return undefined
    const origin = note.originScope
    if (!origin) return undefined
    return props.scopeLookup.get(origin)?.name ?? "Archived project"
  }

  return (
    <section
      ref={sectionRef}
      class="note-scope-section"
      classList={{
        "note-scope-section--current": props.group.isCurrent,
      }}
    >
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="note-scope-header"
          aria-expanded={props.expanded}
          aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.group.name} notes`}
          onClick={props.onToggle}
        >
          <span
            class="shrink-0 text-icon-weak-base transition-transform duration-150"
            classList={{ "rotate-90": props.expanded }}
          >
            <Icon name={getSemanticIcon("navigation.expand")} size="small" />
          </span>
          <Show when={props.group.scopeType === "home"}>
            <Icon name={getSemanticIcon("navigation.home")} size="small" class="text-icon-weak-base shrink-0" />
          </Show>
          <Show when={props.group.scopeType === "project" && !props.group.archived}>
            <Icon name={getSemanticIcon("notes.folder")} size="small" class="text-icon-weak-base shrink-0" />
          </Show>
          <Show when={props.group.archived}>
            <Icon name={getSemanticIcon("notes.archive")} size="small" class="text-icon-weak-base shrink-0" />
          </Show>
          <span class="min-w-0 truncate text-12-medium text-text-strong">{props.group.name}</span>
          <Show when={props.group.isCurrent}>
            <span class="note-scope-current-badge">
              <span class="size-1.5 rounded-full bg-text-diff-add-base/80" />
              {props.lingui._(N.current)}
            </span>
          </Show>
          <span class="flex-1" />
          <span class="shrink-0 text-11-regular text-text-weaker">{noteCountLabel()}</span>
          <Show when={latestUpdated()}>
            <span class="hidden shrink-0 text-11-regular text-text-weaker sm:inline">
              · {relativeTime(fmt, latestUpdated()!)}
            </span>
          </Show>
        </button>
        <Show when={!props.group.archived}>
          <button
            type="button"
            class="note-scope-new-button"
            onClick={props.onCreateNote}
            title={props.lingui._(N.newNote)}
          >
            <Icon name={getSemanticIcon("action.add")} size="small" />
          </button>
        </Show>
      </div>

      <Show
        when={props.expanded}
        fallback={
          <Show when={shelfNotes().length > 0}>
            <div
              class="note-card-grid note-card-grid--shelf"
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
                    selecting={props.selecting}
                    selected={props.selectedNotes?.has(note.id) ?? false}
                    onToggleSelect={props.onToggleSelect}
                    lingui={props.lingui}
                  />
                )}
              </For>
            </div>
            <Show when={hasMore()}>
              <button type="button" class="note-scope-view-all" onClick={props.onToggle}>
                {props.lingui._({
                  id: N.viewAllNotes.id,
                  message: N.viewAllNotes.message,
                  values: { count: props.group.notes.length },
                })}
                <Icon name={getSemanticIcon("navigation.expand")} size="small" class="size-3" />
              </button>
            </Show>
          </Show>
        }
      >
        <Show
          when={props.group.notes.length > 0}
          fallback={<div class="py-4 text-center text-12-regular text-text-weaker">{props.lingui._(N.noNotes)}</div>}
        >
          <div
            class="note-card-grid note-card-grid--expanded"
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
                  selecting={props.selecting}
                  selected={props.selectedNotes?.has(note.id) ?? false}
                  onToggleSelect={props.onToggleSelect}
                  lingui={props.lingui}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  )
}

export function NotePanel(props: { tab?: WorkbenchPanelTab } = {}) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const lingui = useLingui()

  const [view, setView] = createSignal<"list" | "editor">("list")
  const [selectedNoteId, setSelectedNoteId] = createSignal<string | null>(null)
  const [selectedNoteDir, setSelectedNoteDir] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal("")
  const [kindFilter, setKindFilter] = createSignal<NoteKindFilter>("all")
  const [expandedState, setExpandedState] = createSignal<Record<string, boolean>>({})
  const [selecting, setSelecting] = createSignal(false)
  const [selectedNotes, setSelectedNotes] = createSignal<Set<string>>(new Set())
  const [lastClickedID, setLastClickedID] = createSignal<string | null>(null)
  const [batchBusy, setBatchBusy] = createSignal(false)
  const [showArchived, setShowArchived] = createSignal(false)

  const currentScopeID = createMemo(() => {
    const dir = directory()
    if (!dir || dir === "home") return "home"
    const scope = globalSync.data.scope.find((s) => s.worktree === dir || (s.sandboxes ?? []).includes(dir))
    return scope?.id ?? ""
  })

  const scopeLookup = createMemo(() => {
    const map = new Map<string, { name: string; directory: string }>()
    map.set("home", { name: getScopeLabel(undefined, "home"), directory: "home" })
    for (const scope of globalSync.data.scope) {
      map.set(scope.id, {
        name: getScopeLabel(scope),
        directory: scope.worktree,
      })
    }
    return map
  })

  const [rawGroups, { refetch, mutate: mutateRawGroups }] = createResource(
    () => ({ dir: directory(), reconnect: globalSync.reconnectVersion(), showArchived: showArchived() }),
    async ({ dir, showArchived }) => {
      if (!dir) return []
      if (showArchived) {
        const [active, archived] = await Promise.all([
          sdk.client.note.listMeta({ directory: dir, archived: "false" }),
          sdk.client.note.listMeta({ directory: dir, archived: "true" }),
        ])
        const activeGroups = (active.data ?? []) as NoteMetaScopeGroup[]
        const archivedGroups = (archived.data ?? []) as NoteMetaScopeGroup[]
        const merged: NoteMetaScopeGroup[] = []
        const byScope = new Map<string, NoteMetaScopeGroup>()
        for (const g of activeGroups) {
          const existing = byScope.get(g.scopeID)
          if (existing) existing.notes.push(...g.notes)
          else {
            byScope.set(g.scopeID, { ...g, notes: [...g.notes] })
            merged.push(byScope.get(g.scopeID)!)
          }
        }
        for (const g of archivedGroups) {
          const existing = byScope.get(g.scopeID)
          if (existing) existing.notes.push(...g.notes)
          else {
            byScope.set(g.scopeID, { ...g, notes: [...g.notes] })
            merged.push(byScope.get(g.scopeID)!)
          }
        }
        return merged
      }
      const result = await sdk.client.note.listMeta({ directory: dir, archived: "false" })
      return (result.data ?? []) as NoteMetaScopeGroup[]
    },
  )

  const [loops, { mutate: mutateLoops }] = createResource(
    () => ({ dir: directory(), reconnect: globalSync.reconnectVersion() }),
    async ({ dir }) => {
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

  function patchNoteMeta(scopeID: string, meta: NoteMetaInfo) {
    mutateRawGroups(
      patchNoteGroups(rawGroups() ?? [], {
        scopeID,
        currentScopeID: currentScopeID(),
        showArchived: showArchived(),
        meta,
      }),
    )
  }

  const updateLoop = (loop: BlueprintLoopInfo) => {
    mutateLoops(patchBlueprintLoops(loops() ?? [], loop, currentScopeID()))
  }
  const unsubNoteListEvents = sdk.event.listen((entry: { details: SynergyEvent }) => {
    const event = entry.details
    if (event.type === "note.created") {
      patchNoteMeta(event.properties.scopeID, event.properties.meta)
      return
    }
    if (event.type === "note.updated") {
      patchNoteMeta(event.properties.scopeID, event.properties.meta)
      return
    }
    if (event.type === "note.deleted") {
      mutateRawGroups(removeNotesFromGroups(rawGroups() ?? [], [event.properties.id]))
      return
    }
    if (event.type === "note.archived") {
      mutateRawGroups(
        patchNoteGroupsMany(rawGroups() ?? [], {
          scopeID: event.properties.scopeID,
          currentScopeID: currentScopeID(),
          showArchived: showArchived(),
          metas: event.properties.metas,
        }),
      )
      return
    }
    if (event.type === "note.unarchived") {
      mutateRawGroups(
        patchNoteGroupsMany(rawGroups() ?? [], {
          scopeID: event.properties.scopeID,
          currentScopeID: currentScopeID(),
          showArchived: showArchived(),
          metas: event.properties.metas,
        }),
      )
      return
    }
    if (event.type === "blueprint_loop.created" || event.type === "blueprint_loop.updated") {
      updateLoop(event.properties.loop)
    }
  })
  onCleanup(() => {
    unsubNoteListEvents()
  })

  const noteStats = createMemo(() => {
    let total = 0
    let blueprints = 0
    for (const g of rawGroups() ?? []) {
      for (const n of g.notes) {
        total += 1
        if (isBlueprintNote(n)) blueprints += 1
      }
    }
    return {
      total,
      blueprints,
      notes: total - blueprints,
    }
  })

  const displayGroups = createMemo(() => {
    void selecting()
    void selectedNotes().size
    const groups = rawGroups() ?? []
    const lookup = scopeLookup()
    const curID = currentScopeID()
    const q = search().toLowerCase().trim()
    const activeKind = kindFilter()
    const showArch = showArchived()
    const archived: NoteCardInfo[] = []

    const mapped = groups
      .map((g): DisplayGroup | undefined => {
        const meta = lookup.get(g.scopeID)
        const isCurrent = g.scopeID === curID
        const deregistered = g.scopeType === "project" && !meta && !isCurrent
        const groupDirectory = meta?.directory ?? (g.scopeID === "home" ? "home" : isCurrent ? (directory() ?? "") : "")
        let notes: NoteCardInfo[] = [...g.notes]
        if (q) {
          notes = notes.filter((n) => {
            if (n.title.toLowerCase().includes(q)) return true
            const searchText = n.searchText ?? ""
            return searchText.toLowerCase().includes(q)
          })
        }
        if (activeKind !== "all") {
          notes = notes.filter((n) => (activeKind === "blueprint" ? isBlueprintNote(n) : !isBlueprintNote(n)))
        }
        notes.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.time.updated - a.time.updated
        })
        if (deregistered) {
          archived.push(...notes)
          return undefined
        }
        const archivedMember = notes.filter((n) => n.archived)
        const activeMember = notes.filter((n) => !n.archived)
        if (!showArch) {
          sortNotes(activeMember)
          return {
            ...g,
            notes: activeMember,
            name: meta?.name ?? (g.scopeID === "home" ? getScopeLabel(undefined, "home") : "Archived project"),
            directory: groupDirectory,
            isCurrent,
          }
        }
        archived.push(...archivedMember)
        sortNotes(activeMember)
        return {
          ...g,
          notes: activeMember,
          name: meta?.name ?? (g.scopeID === "home" ? getScopeLabel(undefined, "home") : "Archived project"),
          directory: groupDirectory,
          isCurrent,
        }
      })
      .filter((g): g is DisplayGroup => g !== undefined)

    if (showArch && archived.length > 0) {
      sortNotes(archived)
      mapped.push({
        scopeID: "__archived__",
        scopeType: "project",
        notes: archived,
        name: "Archived",
        directory: directory() ?? "home",
        isCurrent: false,
        archived: true,
      })
    }

    return mapped
      .filter((g) => {
        const hasFilters = q || activeKind !== "all"
        return hasFilters ? g.notes.length > 0 : g.notes.length > 0 || g.isCurrent
      })
      .sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
        if ((a.archived ?? false) !== (b.archived ?? false)) return a.archived ? 1 : -1
        const latestA = a.notes[0]?.time.updated ?? 0
        const latestB = b.notes[0]?.time.updated ?? 0
        return latestB - latestA
      })
  })

  const totalNotes = createMemo(() => (rawGroups() ?? []).reduce((sum, g) => sum + g.notes.length, 0))
  const visibleNotes = createMemo(() => displayGroups().reduce((sum, g) => sum + g.notes.length, 0))
  const filterOptions = createMemo(() => [
    {
      value: "all" as const,
      label: lingui._({ id: N.filterAll.id, message: N.filterAll.message }),
      count: noteStats().total,
    },
    {
      value: "note" as const,
      label: lingui._({ id: N.filterNotes.id, message: N.filterNotes.message }),
      count: noteStats().notes,
    },
    {
      value: "blueprint" as const,
      label: lingui._({ id: N.filterBlueprints.id, message: N.filterBlueprints.message }),
      count: noteStats().blueprints,
    },
  ])

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

  createEffect(
    on(
      () => [props.tab?.resourceId, props.tab?.source] as const,
      ([id, source]) => {
        if (!id) return
        openNote(id, source || directory() || HOME_SCOPE_KEY)
      },
    ),
  )

  async function createNoteInScope(dir: string) {
    if (!dir) return
    try {
      const result = await sdk.client.note.create({
        directory: dir,
        noteCreateInput: { title: "" },
      })
      if (result.data) {
        openNote(result.data.id, dir)
      }
    } catch (e) {
      console.error("Failed to create note", e)
    }
  }

  const confirm = useConfirm()

  function sortNotes(list: NoteCardInfo[]) {
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.time.updated - a.time.updated
    })
  }

  function getVisibleNoteIDs(): string[] {
    const ids: string[] = []
    for (const g of displayGroups()) {
      for (const n of g.notes) ids.push(n.id)
    }
    return ids
  }

  function toggleSelect(id: string, shiftKey?: boolean) {
    if (shiftKey) {
      const last = lastClickedID()
      if (last) {
        const visible = getVisibleNoteIDs()
        const lastIdx = visible.indexOf(last)
        const currIdx = visible.indexOf(id)
        if (lastIdx >= 0 && currIdx >= 0) {
          const [start, end] = lastIdx <= currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx]
          const rangeIDs = visible.slice(start, end + 1)
          setSelectedNotes((prev) => {
            const next = new Set(prev)
            const allAlready = rangeIDs.every((rid) => next.has(rid))
            if (allAlready) {
              for (const rid of rangeIDs) next.delete(rid)
            } else {
              for (const rid of rangeIDs) next.add(rid)
            }
            return next
          })
          return
        }
      }
    }
    setLastClickedID(id)
    setSelectedNotes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function batchArchive() {
    const ids = [...selectedNotes()]
    confirm.show({
      ...archiveNoteConfirm(ids.length),
      onConfirm: async () => {
        setBatchBusy(true)
        try {
          await sdk.client.note.batch({ ids, action: "archive", directory: directory() })
        } catch (e) {
          console.error("Batch archive failed", e)
        }
        setSelectedNotes(new Set<string>())
        setSelecting(false)
        setBatchBusy(false)
      },
    })
  }

  async function batchUnarchive() {
    const ids = [...selectedNotes()]
    confirm.show({
      ...unarchiveNoteConfirm(ids.length),
      onConfirm: async () => {
        setBatchBusy(true)
        try {
          await sdk.client.note.batch({ ids, action: "unarchive", directory: directory() })
        } catch (e) {
          console.error("Batch unarchive failed", e)
        }
        setSelectedNotes(new Set<string>())
        setSelecting(false)
        setBatchBusy(false)
      },
    })
  }

  function cancelSelecting() {
    setSelecting(false)
    setSelectedNotes(new Set<string>())
    setLastClickedID(null)
  }

  async function batchDelete() {
    const ids = [...selectedNotes()]
    confirm.show({
      ...deleteArchivedNoteConfirm(ids.length),
      onConfirm: async () => {
        setBatchBusy(true)
        try {
          await sdk.client.note.batch({ ids, action: "delete", directory: directory() })
        } catch (e) {
          console.error("Batch delete failed", e)
        }
        setSelectedNotes(new Set<string>())
        setSelecting(false)
        setBatchBusy(false)
      },
    })
  }

  createEffect(() => {
    if (!selecting()) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancelSelecting()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <div class="flex flex-col h-full bg-background-base relative">
      <style>{TIPTAP_STYLES}</style>

      <Show when={view() === "list"}>
        <div class="flex flex-col h-full">
          <div class="shrink-0 px-4 pt-3 pb-2">
            <div class="flex flex-wrap items-center gap-2.5 rounded-xl bg-surface-inset-base/60 px-3.5 py-2.5 transition-colors">
              <Icon name={getSemanticIcon("notes.search")} size="small" class="text-icon-weak-base shrink-0" />
              <input
                type="text"
                placeholder={lingui._({ id: N.searchNotes.id, message: N.searchNotes.message })}
                class="min-w-32 flex-1 bg-transparent text-13-regular text-text-base placeholder:text-text-weak outline-none"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
              <Show when={search()}>
                <button
                  type="button"
                  class="flex items-center justify-center size-5 rounded-md text-icon-weak-base hover:text-icon-base transition-colors"
                  aria-label={lingui._({ id: N.clearSearch.id, message: N.clearSearch.message })}
                  onClick={() => setSearch("")}
                >
                  <Icon name={getSemanticIcon("action.close")} size="small" />
                </button>
              </Show>
              <div class="note-kind-filter ml-1 flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-base/62 p-0.5">
                <For each={filterOptions()}>
                  {(option) => (
                    <button
                      type="button"
                      classList={{
                        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-11-medium transition-colors": true,
                        "bg-surface-raised-stronger-non-alpha text-text-base shadow-xs": kindFilter() === option.value,
                        "text-text-weak hover:bg-surface-raised-base-hover hover:text-text-base":
                          kindFilter() !== option.value,
                      }}
                      onClick={() => setKindFilter(option.value)}
                    >
                      <span>{option.label}</span>
                      <span class="text-10-regular opacity-60">{option.count}</span>
                    </button>
                  )}
                </For>
              </div>
              <span class="mr-0.5 whitespace-nowrap text-11-regular text-text-weak">
                {visibleNotes() === totalNotes() ? `${totalNotes()}` : `${visibleNotes()} / ${totalNotes()}`}
              </span>
              <button
                type="button"
                classList={{
                  "flex items-center justify-center size-7 rounded-lg transition-colors": true,
                  "text-icon-base bg-surface-raised-stronger-non-alpha": showArchived(),
                  "text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover": !showArchived(),
                }}
                onClick={() => setShowArchived((v) => !v)}
                title={
                  showArchived()
                    ? lingui._({ id: N.showActive.id, message: N.showActive.message })
                    : lingui._({ id: N.showArchived.id, message: N.showArchived.message })
                }
              >
                <Icon name={getSemanticIcon("notes.archive")} size="small" />
              </button>
              <Show when={!selecting()}>
                <button
                  type="button"
                  class="flex items-center justify-center size-7 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                  onClick={() => setSelecting(true)}
                  title={lingui._({ id: N.selectNotes.id, message: N.selectNotes.message })}
                >
                  <Icon name={getSemanticIcon("notes.select")} size="small" />
                </button>
              </Show>
              <button
                type="button"
                class="flex items-center justify-center size-7 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
                onClick={() => refetch()}
                title={lingui._({ id: N.refresh.id, message: N.refresh.message })}
              >
                <Icon name={getSemanticIcon("action.refresh")} size="small" />
              </button>
            </div>
          </div>

          <Show when={selecting()}>
            <div class="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 library-inner-surface">
              <div class="flex min-w-0 items-center gap-2">
                <span class="text-12-medium text-text-base">
                  {selectedNotes().size} / {visibleNotes()}{" "}
                  {lingui._({ id: N.selected.id, message: N.selected.message })}
                </span>
                <Show when={selectedNotes().size < visibleNotes()}>
                  <button
                    type="button"
                    class="rounded-full px-2.5 py-1 text-11-medium text-text-base ring-1 ring-inset ring-border-base/35 transition-colors hover:bg-surface-raised-base-hover"
                    onClick={() => {
                      const all = new Set<string>()
                      for (const g of displayGroups()) {
                        for (const n of g.notes) all.add(n.id)
                      }
                      setSelectedNotes(all)
                    }}
                  >
                    {lingui._({ id: N.selectAll.id, message: N.selectAll.message })}
                  </button>
                </Show>
              </div>
              <div class="flex items-center gap-1.5">
                <Show when={selectedNotes().size > 0}>
                  <Show
                    when={displayGroups().some((g) => g.archived)}
                    fallback={
                      <button
                        type="button"
                        class="flex items-center gap-1 rounded-full px-3 py-1.5 text-11-medium ring-1 ring-inset transition-all text-text-diff-delete-base ring-text-diff-delete-base/15 hover:bg-text-diff-delete-base/8"
                        onClick={batchArchive}
                        disabled={batchBusy()}
                      >
                        <Show when={!batchBusy()} fallback={<Spinner class="size-3" />}>
                          {lingui._({ id: N.archive.id, message: N.archive.message })} ({selectedNotes().size})
                        </Show>
                      </button>
                    }
                  >
                    <>
                      <button
                        type="button"
                        class="flex items-center gap-1 rounded-full px-3 py-1.5 text-11-medium ring-1 ring-inset transition-all hover:bg-surface-raised-base-hover text-text-base ring-border-base/35"
                        onClick={batchUnarchive}
                        disabled={batchBusy()}
                      >
                        {lingui._({ id: N.restore.id, message: N.restore.message })} ({selectedNotes().size})
                      </button>
                      <button
                        type="button"
                        class="flex items-center gap-1 rounded-full px-3 py-1.5 text-11-medium ring-1 ring-inset transition-all text-text-diff-delete-base ring-text-diff-delete-base/15 hover:bg-text-diff-delete-base/8"
                        onClick={batchDelete}
                        disabled={batchBusy()}
                      >
                        {lingui._({ id: N.deletePermanently.id, message: N.deletePermanently.message })} (
                        {selectedNotes().size})
                      </button>
                    </>
                  </Show>
                </Show>
                <button
                  type="button"
                  class="rounded-full px-3 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
                  onClick={cancelSelecting}
                >
                  {lingui._({ id: N.cancel.id, message: N.cancel.message })}
                </button>
              </div>
            </div>
          </Show>

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
                    <Icon name={getSemanticIcon("notes.main")} size="large" class="text-icon-weak-base" />
                    <div class="text-14-medium text-text-weak">
                      {lingui._({ id: N.noNotesFound.id, message: N.noNotesFound.message })}
                    </div>
                  </div>
                }
              >
                <div class="flex flex-col">
                  <For each={displayGroups()}>
                    {(group) => (
                      <ScopeSection
                        lingui={lingui}
                        group={group}
                        expanded={isExpanded(group.scopeID, group.isCurrent)}
                        loopsByNote={loopsByNote()}
                        onToggle={() => toggleExpanded(group.scopeID, group.isCurrent)}
                        onOpenNote={(id) => openNote(id, group.directory)}
                        onCreateNote={() => createNoteInScope(group.directory)}
                        scopeLookup={scopeLookup()}
                        selecting={selecting()}
                        selectedNotes={selectedNotes()}
                        onToggleSelect={toggleSelect}
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
          directory={selectedNoteDir() ?? directory() ?? "home"}
          onBack={() => {
            setView("list")
          }}
          onDelete={() => {
            setView("list")
          }}
          loops={loopsByNote().get(selectedNoteId()!) ?? []}
        />
      </Show>
    </div>
  )
}

type NoteConflictState = {
  type: "remote-update"
  message: string
  remote: NoteInfo
}

function NoteEditor(props: {
  id: string
  directory: string
  loops: BlueprintLoopInfo[]
  onBack: () => void
  onDelete: () => void
}) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const data = useData()
  const platform = usePlatform()
  const params = useParams()
  const confirm = useConfirm()
  const directory = () => props.directory
  const { fmt } = useLocale()
  const lingui = useLingui()

  const [note, { refetch }] = createResource(
    () => ({ id: props.id, dir: directory(), reconnect: globalSync.reconnectVersion() }),
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
  const [dirty, setDirty] = createSignal<NoteDirtyRevisions>(EMPTY_DIRTY_REVISIONS)
  const [conflict, setConflict] = createSignal<NoteConflictState | null>(null)
  const [editor, setEditor] = createSignal<Editor>()
  const [convertingBlueprint, setConvertingBlueprint] = createSignal(false)
  const [runningBlueprint, setRunningBlueprint] = createSignal(false)
  const [showRunMenu, setShowRunMenu] = createSignal(false)

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let saveQueued = false
  let saveInFlight: Promise<void> | undefined
  let draftRevision = 0

  const noteLoaded = createMemo(() => !!baseNote())
  const isBlueprint = createMemo(() => baseNote()?.kind === "blueprint")
  const routeDirectory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const blueprintScopes = createMemo(() =>
    globalSync.data.scope.map((scope) => ({
      id: scope.id,
      worktree: scope.worktree,
      sandboxes: scope.sandboxes,
      vcs: scope.vcs,
    })),
  )
  const canRunCurrentSession = createMemo(() =>
    canRunBlueprintInCurrentSession({
      sessionID: params.id,
      blueprintDirectory: directory(),
      routeDirectory: routeDirectory(),
      scopes: blueprintScopes(),
    }),
  )
  const canRunWorktreeSession = createMemo(() =>
    canCreateBlueprintWorktree({
      blueprintDirectory: directory(),
      scopes: blueprintScopes(),
    }),
  )
  const noteLoops = createMemo(() => props.loops ?? [])
  const blueprintState = createMemo(() => {
    const base = baseNote()
    if (!base) return null
    return getBlueprintVisualState(lingui, base, noteLoops())
  })
  const activeBlueprintRun = createMemo(() => {
    const base = baseNote()
    if (!base) return undefined
    return activeBlueprintLoop(base, noteLoops())
  })

  function remoteConflict() {
    const current = conflict()
    if (current?.type !== "remote-update") return null
    return current.remote
  }

  const hasDirty = createMemo(() => hasDirtyFields(dirty()))

  function markDirty(field: NoteDirtyField) {
    const revision = ++draftRevision
    setDirty((current) => ({ ...current, [field]: revision }))
    if (!remoteConflict()) setConflict(null)
  }

  function clearDebounce() {
    if (!debounceTimer) return
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }

  function clearDirty() {
    setDirty(cloneDirtyRevisions(EMPTY_DIRTY_REVISIONS))
  }

  function captureDirty() {
    return cloneDirtyRevisions(dirty())
  }

  function replaceEditorContent(content: unknown) {
    const ed = editor()
    if (!ed || ed.isDestroyed) return
    if (!shouldReplaceEditorContent(ed.getJSON(), content)) return
    const scrollParent = ed.view.dom.parentElement
    const scrollTop = scrollParent?.scrollTop
    const { from } = ed.state.selection
    ed.commands.setContent(content as any, { emitUpdate: false })
    const docSize = ed.state.doc.content.size
    if (from > 0 && from < docSize) {
      try {
        ed.commands.setTextSelection(from)
      } catch {
        // selection may no longer exist in the replacement document
      }
    }
    if (scrollParent && scrollTop !== undefined) {
      scrollParent.scrollTop = scrollTop
      queueMicrotask(() => {
        scrollParent.scrollTop = scrollTop
      })
    }
  }

  function applySnapshot(
    snapshot: NoteInfo,
    options: { mode?: "replace" | "merge"; changed?: NoteChangedField[]; message?: string } = {},
  ) {
    const mode = options.mode ?? "replace"
    const current = baseNote()
    const changed = options.changed ?? (current ? noteChangedFields(current, snapshot) : ["content", "title", "tags"])
    if (mode === "merge" && current && snapshot.version <= current.version) return true

    if (mode === "merge") {
      const conflicts = dirtyConflicts(dirty(), changed)
      if (conflicts.length > 0) {
        setConflict({
          type: "remote-update",
          message: options.message ?? "This note was updated elsewhere while you were editing.",
          remote: snapshot,
        })
        return false
      }
      const currentDirty = dirty()
      setBaseNote(snapshot)
      if (!currentDirty.title) setTitle(snapshot.title)
      if (!currentDirty.tags) setTags(snapshot.tags ?? [])
      if (!currentDirty.content && changed.includes("content")) replaceEditorContent(snapshot.content)
      setConflict(null)
      return true
    }

    setBaseNote(snapshot)
    setTitle(snapshot.title)
    setTags(snapshot.tags ?? [])
    setConflict(null)
    clearDirty()
    replaceEditorContent(snapshot.content)
    return true
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
    const captured = captureDirty()
    if (!dir || !base || !draft || !hasDirtyFields(captured) || remoteConflict()) return

    const notePatchInput: NotePatchInput = { expectedVersion: base.version }
    if (captured.title) notePatchInput.title = draft.title
    if (captured.content) notePatchInput.content = draft.content
    if (captured.tags) notePatchInput.tags = draft.tags

    setSaving(true)
    try {
      const result = await sdk.client.note.update({
        id: props.id,
        directory: dir,
        notePatchInput,
      })
      const saved = result.data as NoteInfo
      setBaseNote(saved)
      const currentDirty = dirty()
      if (!currentDirty.title || currentDirty.title === captured.title) setTitle(saved.title)
      if (!currentDirty.tags || currentDirty.tags === captured.tags) setTags(saved.tags ?? [])
      setDirty((current) => clearCapturedDirty(current, captured))
      setConflict(null)
    } catch (error) {
      const remote = parseConflict(error)
      if (remote) {
        const current = baseNote()
        const merged = applySnapshot(remote, {
          mode: "merge",
          changed: current ? noteChangedFields(current, remote) : undefined,
          message: "This note was updated elsewhere. Review the remote version or overwrite it with your draft.",
        })
        if (merged && hasDirtyFields(dirty())) saveQueued = true
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
    if (!hasDirty()) return
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
    if (!hasDirty()) {
      applySnapshot(incoming)
      return
    }
    applySnapshot(incoming, {
      mode: "merge",
      changed: noteChangedFields(current, incoming),
      message: "This note was updated elsewhere while you were editing.",
    })
  })

  const unsubEditorNoteEvents = sdk.event.listen((entry: { details: SynergyEvent }) => {
    const event = entry.details
    if (event.type === "note.updated") {
      const incoming = event.properties.note
      if (incoming.id !== props.id) return
      const current = baseNote()
      if (!current || incoming.version <= current.version) return
      applySnapshot(incoming, {
        mode: "merge",
        changed: event.properties.changed,
        message: "This note was updated elsewhere while you were editing.",
      })
      return
    }
    if (event.type === "note.deleted" && event.properties.id === props.id) props.onDelete()
  })

  onCleanup(() => {
    clearDebounce()
    unsubEditorNoteEvents()
  })

  async function handleBack() {
    await flushSave()
    if (remoteConflict()) return
    props.onBack()
  }

  async function saveMetadata(patch: { pinned?: boolean; global?: boolean }) {
    const dir = directory()
    if (!dir || !baseNote()) return false
    setSaving(true)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const base = baseNote()
        if (!base) return false
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
          if (!remote) throw error
          const current = baseNote()
          const merged = applySnapshot(remote, {
            mode: "merge",
            changed: current ? noteChangedFields(current, remote) : undefined,
            message: "This note changed before your metadata update could be saved.",
          })
          if (attempt === 0 && merged && !remoteConflict()) continue
          return false
        }
      }
      return false
    } catch (error) {
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
    markDirty("tags")
    scheduleSave()
    setTagInput("")
  }

  function removeTag(tag: string) {
    setTags(tags().filter((t) => t !== tag))
    markDirty("tags")
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
    markDirty("title")
    scheduleSave()
  }

  async function togglePin() {
    await flushSave()
    if (remoteConflict()) return
    const current = baseNote()
    if (!current) return
    await saveMetadata({ pinned: !current.pinned })
  }

  async function toggleGlobal() {
    await flushSave()
    if (remoteConflict()) return
    const current = baseNote()
    if (!current) return
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
    if (hasDirty()) saveQueued = true
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
    await flushSave()
    if (remoteConflict()) return
    const latest = baseNote()
    if (!latest) return

    setConvertingBlueprint(true)
    try {
      const result = await sdk.client.note.update({
        id: latest.id,
        directory: dir,
        notePatchInput: {
          kind: "blueprint",
          blueprint: {},
          expectedVersion: latest.version,
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
    await flushSave()
    if (remoteConflict()) return
    const latest = baseNote()
    if (!latest) return
    if (latest.blueprint?.activeLoopID || noteLoops().some((loop) => isActiveBlueprintLoopStatus(loop.status))) {
      alert("This Blueprint has an active loop. Finish or cancel the loop before converting it back to a Note.")
      return
    }

    setConvertingBlueprint(true)
    try {
      const result = await sdk.client.note.update({
        id: latest.id,
        directory: dir,
        notePatchInput: {
          kind: "note",
          expectedVersion: latest.version,
        },
      })
      applySnapshot(result.data as NoteInfo)
    } catch (error) {
      const remote = parseConflict(error)
      if (remote) {
        setConflict({
          type: "remote-update",
          message: "This note changed before it could be converted from a Blueprint.",
          remote,
        })
        return
      }
      console.error("Failed to convert blueprint to note", error)
    } finally {
      setConvertingBlueprint(false)
    }
  }

  function openBlueprintSession(sessionID: string) {
    data.navigateToSession?.(sessionID)
  }

  function scopedClient(directory: string) {
    globalSync.ensureScopeState(directory)
    return createSynergyClient({
      baseUrl: sdk.url,
      fetch: platform.fetch,
      directory,
      throwOnError: true,
    })
  }

  async function createExecutionSession(mode: BlueprintRunMode, blueprintDir: string) {
    if (mode === "current") {
      if (!canRunCurrentSession() || !params.id) {
        alert("Open a session in this Blueprint scope before running it there.")
        return undefined
      }
      return {
        sessionID: params.id,
        createdSession: false,
        client: scopedClient(blueprintDir),
      }
    }

    const client = scopedClient(blueprintDir)
    const session = await client.session
      .create({
        workspace: blueprintSessionWorkspaceSelection(mode),
        controlProfile: blueprintExecutionControlProfile(sync.data.config.controlProfile),
      })
      .then((result) => result.data)
    if (!session?.id) throw new Error("Failed to create session")
    return {
      sessionID: session.id,
      createdSession: true,
      client,
    }
  }

  async function runBlueprint(mode: BlueprintRunMode, model?: { providerID: string; modelID: string }) {
    const dir = directory()
    if (!dir || runningBlueprint()) return
    await flushSave()
    if (remoteConflict()) return
    const base = baseNote()
    if (!base || !isBlueprint()) return
    const activeLoop = activeBlueprintLoop(base, noteLoops())
    if (activeLoop) {
      alert("This Blueprint already has an active run. Finish or cancel it before starting another run.")
      return
    }

    setRunningBlueprint(true)
    let createdLoopID: string | undefined
    let target: Awaited<ReturnType<typeof createExecutionSession>> | undefined
    try {
      target = await createExecutionSession(mode, dir)
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
            ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          },
        })
        .then((result) => result.data)
      if (!loop?.id) throw new Error("Failed to create BlueprintLoop")
      createdLoopID = loop.id
      await sdk.client.blueprint.loop.start({ id: loop.id, directory: dir })
      setShowRunMenu(false)
    } catch (error) {
      if (createdLoopID) {
        await sdk.client.blueprint.loop.cancel({ id: createdLoopID, directory: dir }).catch(() => undefined)
      }
      if (target?.createdSession) {
        await target.client.session.delete({ sessionID: target.sessionID }).catch(() => undefined)
      }
      await Promise.resolve(refetch()).catch(() => undefined)
      console.error("Failed to run blueprint", error)
      alert(requestErrorMessage(error, "Failed to run blueprint"))
    } finally {
      setRunningBlueprint(false)
    }
  }

  const isArchived = createMemo(() => baseNote()?.archived ?? false)

  async function archiveNote() {
    const dir = directory()
    if (!dir) return
    await flushSave()
    if (remoteConflict()) return
    confirm.show({
      ...archiveNoteConfirm(1),
      onConfirm: async () => {
        await sdk.client.note.batch({ ids: [props.id], action: "archive", directory: dir })
        props.onBack()
      },
    })
  }

  async function restoreNote() {
    const dir = directory()
    if (!dir) return
    await flushSave()
    if (remoteConflict()) return
    await sdk.client.note.batch({ ids: [props.id], action: "unarchive", directory: dir })
  }

  async function deleteArchivedNote() {
    const dir = directory()
    if (!dir) return
    confirm.show({
      ...deleteArchivedNoteConfirm(1),
      onConfirm: async () => {
        await sdk.client.note.batch({ ids: [props.id], action: "delete", directory: dir })
        props.onDelete()
      },
    })
  }

  let conflictBannerEl: HTMLDivElement | undefined

  function handleRunBlueprint() {
    setShowRunMenu(true)
  }

  onCleanup(() => {
    clearDebounce()
  })

  return (
    <div class="flex h-full flex-col bg-background-base">
      <style>{TIPTAP_STYLES}</style>

      <div class="border-b border-border-weaker-base/40">
        <div class="flex items-center gap-2 px-4 py-2">
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
            onClick={handleBack}
            aria-label={lingui._({ id: N.backToList.id, message: N.backToList.message })}
          >
            <Icon name={getSemanticIcon("navigation.back")} size="small" />
          </button>
          <span class="flex-1" />
          <Show when={isBlueprint()}>
            <button
              type="button"
              class="flex items-center gap-1 rounded-full px-2.5 py-1 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/35 transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
              onClick={handleRunBlueprint}
              disabled={runningBlueprint()}
            >
              <Icon name={getSemanticIcon("prompt.blueprintStart")} size="small" class="size-3" />
              {lingui._({ id: N.run.id, message: N.run.message })}
            </button>
          </Show>
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
            onClick={downloadNote}
            aria-label={lingui._({ id: N.downloadNote.id, message: N.downloadNote.message })}
            title={lingui._({ id: N.downloadNote.id, message: N.downloadNote.message })}
          >
            <Icon name={getSemanticIcon("action.download")} size="small" />
          </button>
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
            onClick={togglePin}
            aria-label={
              baseNote()?.pinned
                ? lingui._({ id: N.unpin.id, message: N.unpin.message })
                : lingui._({ id: N.pin.id, message: N.pin.message })
            }
          >
            <Icon
              name={getSemanticIcon(baseNote()?.pinned ? "notes.pin" : "action.pin")}
              size="small"
              class={baseNote()?.pinned ? "text-icon-base" : "text-icon-weak-base"}
            />
          </button>
          <Show when={isBlueprint()}>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
              onClick={convertToNote}
              disabled={convertingBlueprint()}
              aria-label={lingui._({ id: N.convertToNote.id, message: N.convertToNote.message })}
              title={lingui._({ id: N.convertToNote.id, message: N.convertToNote.message })}
            >
              <Icon name={getSemanticIcon("blueprint.main")} size="small" class="opacity-60" />
            </button>
          </Show>
          <Show when={!isBlueprint()}>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
              onClick={convertToBlueprint}
              disabled={convertingBlueprint()}
              aria-label={lingui._({ id: N.convertToBlueprint.id, message: N.convertToBlueprint.message })}
              title={lingui._({ id: N.convertToBlueprint.id, message: N.convertToBlueprint.message })}
            >
              <Icon name={getSemanticIcon("blueprint.main")} size="small" />
            </button>
          </Show>
          <Show when={baseNote()?.global !== undefined}>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-lg transition-colors"
              classList={{
                "text-icon-base bg-text-interactive-base/10": baseNote()?.global,
                "text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base": !baseNote()?.global,
              }}
              onClick={toggleGlobal}
              aria-label={
                baseNote()?.global
                  ? lingui._({ id: N.makeLocal.id, message: N.makeLocal.message })
                  : lingui._({ id: N.makeGlobal.id, message: N.makeGlobal.message })
              }
            >
              <Icon name={getSemanticIcon("navigation.home")} size="small" />
            </button>
          </Show>
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
            onClick={() => props.onDelete()}
            aria-label={lingui._({ id: N.deleteNote.id, message: N.deleteNote.message })}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" />
          </button>
        </div>

        <Show when={conflict()}>
          <div
            ref={conflictBannerEl}
            class="flex items-center gap-2 border-t border-text-diff-delete-base/15 bg-text-diff-delete-base/8 px-4 py-2"
          >
            <span class="flex-1 text-11-regular text-text-diff-delete-base">{conflict()?.message}</span>
            <button
              type="button"
              class="rounded-full px-2 py-0.5 text-10-medium text-text-base ring-1 ring-inset ring-border-base/35 hover:bg-surface-raised-base-hover"
              onClick={reloadRemote}
            >
              {lingui._({ id: N.reloadRemote.id, message: N.reloadRemote.message })}
            </button>
            <button
              type="button"
              class="rounded-full px-2 py-0.5 text-10-medium text-text-base ring-1 ring-inset ring-border-base/35 hover:bg-surface-raised-base-hover"
              onClick={overwriteRemote}
            >
              {lingui._({ id: N.keepMine.id, message: N.keepMine.message })}
            </button>
          </div>
        </Show>

        <Show when={isBlueprint()}>
          <div class="flex items-center gap-2 border-t border-border-weaker-base/40 px-4 py-1.5">
            <Show when={blueprintState()}>
              <span class={`note-blueprint-state note-blueprint-state--${blueprintState()!.tone}`}>
                <Icon name={blueprintState()!.icon} size="small" class="size-3" />
                {blueprintState()!.label}
              </span>
              <span class="text-11-regular text-text-weak">{blueprintState()!.detail}</span>
              <span class="h-3 w-px bg-border-weaker-base" />
              <span class="text-11-regular text-text-weak">
                {getRunCount(baseNote()!, noteLoops()) > 0
                  ? `${getRunCount(baseNote()!, noteLoops())} runs`
                  : "No runs yet"}
              </span>
              <span class="text-11-regular text-text-weak">
                {lingui._({ id: N.lastActivity.id, message: N.lastActivity.message })}{" "}
                {relativeTime(fmt, getBlueprintActivityTime(baseNote()!, noteLoops()))}
              </span>
              <Show when={baseNote()!.blueprint?.defaultAgent}>
                <span class="h-3 w-px bg-border-weaker-base" />
                <span class="text-11-regular text-text-weak">{baseNote()!.blueprint!.defaultAgent}</span>
              </Show>
              <Show when={activeBlueprintRun()?.sessionID} keyed>
                {(sessionID) => (
                  <>
                    <span class="h-3 w-px bg-border-weaker-base" />
                    <button
                      type="button"
                      class="note-blueprint-session-link"
                      onClick={() => openBlueprintSession(sessionID)}
                    >
                      <Icon name={getSemanticIcon("action.open")} size="small" class="size-3" />
                      {lingui._({ id: N.openSession.id, message: N.openSession.message })}
                    </button>
                  </>
                )}
              </Show>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={!noteLoaded()}>
        <div class="flex flex-1 items-center justify-center">
          <Spinner class="size-4" />
        </div>
      </Show>

      <Show when={noteLoaded()}>
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <input
            type="text"
            class="w-full border-none bg-transparent text-16-medium text-text-strong outline-none placeholder:text-text-weaker"
            placeholder={lingui._({ id: N.untitled.id, message: N.untitled.message })}
            value={title()}
            onInput={onTitleInput}
          />

          <DocumentEditorCore
            content={baseNote()?.content}
            onUpdate={() => markDirty("content")}
            onEditorReady={setEditor}
            uploadFile={uploadFile}
            sdkClient={sdk.client}
            sdkUrl={sdk.url}
            saving={saving()}
          />

          <div class="flex flex-wrap items-center gap-1.5">
            <For each={tags()}>
              {(tag) => (
                <span class="inline-flex items-center gap-1 rounded-full bg-surface-inset-base px-2.5 py-1 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/35">
                  {tag}
                  <button
                    type="button"
                    class="flex size-3 items-center justify-center rounded-full text-text-weaker hover:text-text-base"
                    onClick={() => removeTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                  >
                    <Icon name={getSemanticIcon("action.close")} size="small" class="size-2.5" />
                  </button>
                </span>
              )}
            </For>
            <input
              type="text"
              class="min-w-[80px] flex-1 border-none bg-transparent text-12-regular text-text-weak outline-none placeholder:text-text-weaker"
              placeholder={lingui._({ id: N.addTags.id, message: N.addTags.message })}
              value={tagInput()}
              onInput={(e) => setTagInput(e.currentTarget.value)}
              onKeyDown={handleTagKeyDown}
            />
          </div>
        </div>
      </Show>

      <Show when={showRunMenu() && activeBlueprintRun() === undefined}>
        <RunMenu
          title={baseNote()?.title ?? "Untitled"}
          canRunInCurrentSession={canRunCurrentSession()}
          canCreateWorktree={canRunWorktreeSession()}
          onRun={runBlueprint}
          onClose={() => setShowRunMenu(false)}
        />
      </Show>
    </div>
  )
}
