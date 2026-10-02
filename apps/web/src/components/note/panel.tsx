import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { resourceMenuKeyDown } from "../workspace/resource-menu"
import { List } from "@ericsanchezok/synergy-ui/list"
import { createMemo, createResource, createSignal, For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import { useParams } from "@solidjs/router"
import type { Editor } from "@tiptap/core"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { useWorkbenchPanels } from "@/context/workbench"

import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { TIPTAP_STYLES, DocumentEditorCore } from "@/components/note/document-editor-core"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { archiveNoteConfirm, unarchiveNoteConfirm, deleteArchivedNoteConfirm } from "@/components/dialog/confirm-copy"
import type {
  Agent,
  BlueprintLoopInfo,
  Event as SynergyEvent,
  NoteInfo,
  NoteMetaInfo,
  NoteMetaScopeGroup,
  NotePatchInput,
} from "@ericsanchezok/synergy-sdk/client"
import { getScopeLabel, HOME_SCOPE_KEY, resolveProjectScope } from "@/utils/scope"
import { assetHttpUrl } from "@/utils/asset-url"
import { useLocale } from "@/context/locale"
import { useLingui } from "@lingui/solid"
import { requestErrorMessage } from "@/utils/error"
import { relativeTime } from "@/utils/time"
import { getAgentVisual } from "@/components/agent-visual"
import { translateDescriptor } from "@/locales/translate"
import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"
import {
  activeBlueprintLoop,
  blueprintExecutionAgentOptions,
  blueprintExecutionAgentPatch,
  blueprintExecutionControlProfile,
  blueprintSessionWorkspaceSelection,
  canCreateBlueprintWorktree,
  canRunBlueprintInCurrentSession,
  isActiveBlueprintLoopStatus,
  type BlueprintExecutionAgentOption,
  type BlueprintRunMode,
} from "@/components/note/blueprint-run-session"
import {
  hasDirtyFields,
  isNoteNotFoundError,
  patchBlueprintLoops,
  patchNoteGroups,
  patchNoteGroupsMany,
  removeNotesFromGroups,
  shouldReplaceEditorContent,
} from "@/components/note/note-sync"
import { note as N, panels as P } from "@/locales/messages"
import { useNoteDocuments } from "./documents"
import { WorkspaceNavigator, type WorkspaceNavigatorController } from "../workspace/workspace-navigator"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import "./panel.css"

type LoopStatus = BlueprintLoopInfo["status"]

type NoteCardInfo = NoteMetaInfo & {
  kind?: "note" | "blueprint"
}

type BlueprintVisualState = {
  label: string
  detail: string
  tone: "idle" | "running" | "auditing" | "failed" | "completed"
  icon: ReturnType<typeof getSemanticIcon>
}

function isBlueprintNote(note: { kind?: string; blueprint?: unknown }) {
  return note.kind === "blueprint"
}

function getLoopLabel(lingui: ReturnType<typeof useLingui>, status: LoopStatus) {
  if (status === "armed") return lingui._({ id: N.runQueued.id, message: N.runQueued.message })
  if (status === "running") return lingui._({ id: N.running.id, message: N.running.message })
  if (status === "auditing") return lingui._({ id: N.reviewing.id, message: N.reviewing.message })
  if (status === "completed") return lingui._({ id: N.completed.id, message: N.completed.message })
  if (status === "failed") return lingui._({ id: N.failed.id, message: N.failed.message })
  return lingui._({ id: N.cancelled.id, message: N.cancelled.message })
}

function getLoopTone(status: LoopStatus): BlueprintVisualState["tone"] {
  if (status === "armed" || status === "running") return "running"
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
      icon: status === "auditing" ? getSemanticIcon("command.audit") : getSemanticIcon("command.start"),
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

type NoteKindFilter = "all" | "note" | "blueprint"

function NoteCard(props: {
  note: NoteCardInfo
  originName?: string
  loops?: BlueprintLoopInfo[]
  onClick: (newTab?: boolean) => void
  selecting?: boolean
  selected?: boolean
  onToggleSelect?: (id: string, shiftKey?: boolean) => void
  lingui: ReturnType<typeof useLingui>
}) {
  const { fmt } = useLocale()
  const blueprint = () => isBlueprintNote(props.note)
  const state = () => getBlueprintVisualState(props.lingui, props.note, props.loops ?? [])
  const title = () => props.note.title || props.lingui._(N.untitled)
  return (
    <button
      type="button"
      class="note-resource-row"
      classList={{ "note-resource-row--blueprint": blueprint() }}
      title={title()}
      aria-pressed={props.selecting ? (props.selected ?? false) : undefined}
      draggable={!props.selecting}
      onDragStart={(event) => {
        if (!props.selecting) attachNoteDragData(event, props.note)
      }}
      onClick={(event) => {
        if (props.selecting && props.onToggleSelect) props.onToggleSelect(props.note.id, event.shiftKey)
        else props.onClick(event.metaKey || event.ctrlKey)
      }}
      onKeyDown={(event) => {
        if (!props.selecting && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          props.onClick(true)
        }
      }}
    >
      <Icon
        name={getSemanticIcon(
          props.selecting && props.selected ? "state.success" : blueprint() ? "blueprint.main" : "notes.main",
        )}
        size="small"
      />
      <span class="note-navigation-copy">
        <span>{title()}</span>
        <Show when={blueprint()}>
          <small>{state().label}</small>
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
      </span>
      <Show when={props.note.pinned}>
        <Icon name={getSemanticIcon("notes.pin")} size="small" />
      </Show>
      <time class="note-resource-time" dateTime={new Date(props.note.time.updated).toISOString()}>
        {relativeTime(fmt, props.note.time.updated)}
      </time>
    </button>
  )
}

function NoteCardSkeleton() {
  return (
    <div class="note-resource-loading" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  )
}

function RunMenu(props: {
  agents: Agent[]
  title: string
  executionAgent?: string
  canRunInCurrentSession: boolean
  canCreateWorktree: boolean
  onRun: (mode: BlueprintRunMode, executionAgent: string, model?: { providerID: string; modelID: string }) => void
  onClose: () => void
}) {
  const globalSync = useGlobalSync()
  const lingui = useLingui()
  const [level, setLevel] = createSignal<"mode" | "agent" | "model">("mode")
  const [selectedMode, setSelectedMode] = createSignal<BlueprintRunMode | null>(null)
  const [selectedAgentName, setSelectedAgentName] = createSignal(props.executionAgent?.trim() ?? "")
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

  const executionAgentOptions = createMemo(() => blueprintExecutionAgentOptions(props.agents, selectedAgentName()))
  const currentExecutionAgent = createMemo(() =>
    executionAgentOptions().find((agent) => agent.name === selectedAgentName()),
  )
  const executionAgentLabel = createMemo(() => {
    const agent = currentExecutionAgent()
    if (!agent) return ""
    return translateDescriptor(getAgentVisual(agent.name).label, lingui)
  })

  createEffect(() => {
    if (selectedAgentName()) return
    const first = executionAgentOptions().find((agent) => agent.available)
    if (first) setSelectedAgentName(first.name)
  })

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
    return modelOptions().find((option) => option.value === selectedModelValue()) ?? modelOptions()[0]
  })

  function selectExecutionAgent(option: BlueprintExecutionAgentOption | undefined) {
    if (!option?.available) return
    setSelectedAgentName(option.name)
    setLevel("model")
  }

  function selectModelOption(option: ModelOption | undefined) {
    if (!option) return
    setSelectedModelValue(option.value)
    setPickerOpen(false)
  }

  function handleRun() {
    const mode = selectedMode()
    const agent = currentExecutionAgent()
    if (!mode || !agent?.available) return
    const model = currentModelOption()
    if (model && model.kind === "model") {
      props.onRun(mode, agent.name, { providerID: model.providerID, modelID: model.modelID })
      return
    }
    props.onRun(mode, agent.name)
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
    const mode = selectedMode()
    if (!mode) return ""
    if (mode === "current") return lingui._(N.currentSession)
    if (mode === "new") return lingui._(N.newSessionRun)
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
                  setLevel("agent")
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

      <Show when={level() === "agent"}>
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
              <h3 class="text-13-medium text-text-strong">{lingui._(N.selectExecutionAgent)}</h3>
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
            <span class="note-run-model-label">{lingui._(N.executionAgent)}</span>
            <span class="note-run-model-description">{lingui._(N.executionAgentChooseHelp)}</span>
          </div>
          <List<BlueprintExecutionAgentOption>
            class="settings-model-picker-list note-run-agent-list"
            search={{ placeholder: lingui._(N.searchAgents), autofocus: true }}
            emptyMessage={lingui._(N.noAgentResults)}
            key={(option) => option.name}
            items={executionAgentOptions}
            current={currentExecutionAgent()}
            filterKeys={["name", "description"]}
            onSelect={selectExecutionAgent}
          >
            {(option) => (
              <div class="settings-model-option" classList={{ "opacity-55": !option.available }}>
                <span class="settings-model-option-title">
                  {translateDescriptor(getAgentVisual(option.name).label, lingui)}
                </span>
                <span class="settings-model-option-detail">
                  {option.available
                    ? (option.description ?? option.name)
                    : `${option.name} · ${lingui._(N.agentUnavailable)}`}
                </span>
              </div>
            )}
          </List>
        </div>
      </Show>

      <Show when={level() === "model"}>
        <div class="note-run-menu-header">
          <div class="flex items-start gap-2">
            <button
              type="button"
              class="note-run-menu-back"
              onClick={() => setLevel("agent")}
              title={lingui._(N.back)}
              aria-label={lingui._(N.backToAgent)}
            >
              <Icon name={getSemanticIcon("navigation.back")} size="small" class="size-3.5" />
            </button>
            <div class="min-w-0 flex-1">
              <h3 class="text-13-medium text-text-strong">{lingui._(N.runBlueprint)}</h3>
              <p class="mt-1 line-clamp-2 text-11-regular text-text-weak">
                {modeLabel()}
                {lingui._(N.separator)}
                {executionAgentLabel()}
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
          <Show when={!currentExecutionAgent()?.available}>
            <p class="text-11-regular text-text-diff-delete-base">{lingui._(N.selectedAgentUnavailable)}</p>
          </Show>
          <button
            type="button"
            class="note-run-model-run"
            disabled={!currentExecutionAgent()?.available}
            onClick={handleRun}
          >
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
  onOpenNote: (id: string, newTab?: boolean) => void
  onCreateNote: () => void
  scopeLookup: Map<string, { name: string; directory: string }>
  selecting?: boolean
  selectedNotes?: Set<string>
  onToggleSelect?: (id: string, shiftKey?: boolean) => void
}) {
  const originName = (note: NoteMetaInfo) =>
    props.group.scopeType === "home" && note.originScope
      ? (props.scopeLookup.get(note.originScope)?.name ??
        props.lingui._({ id: "note.scope.archivedProject", message: "Archived project" }))
      : undefined
  return (
    <section class="note-resource-group">
      <div class="note-resource-group-header">
        <button type="button" aria-expanded={props.expanded} aria-label={props.group.name} onClick={props.onToggle}>
          <Icon name={getSemanticIcon(props.expanded ? "navigation.collapse" : "navigation.expand")} size="small" />
          <span>{props.group.name}</span>
          <small>{props.group.notes.length}</small>
        </button>
        <Show when={!props.group.archived}>
          <IconButton
            icon={getSemanticIcon("action.add")}
            variant="ghost"
            onClick={props.onCreateNote}
            aria-label={props.lingui._(N.newNote)}
          />
        </Show>
      </div>
      <Show when={props.expanded}>
        <Show
          when={props.group.notes.length > 0}
          fallback={<div class="note-navigation-message">{props.lingui._(N.noNotes)}</div>}
        >
          <For each={props.group.notes}>
            {(note) => (
              <NoteCard
                note={note}
                originName={originName(note)}
                loops={props.loopsByNote.get(note.id) ?? []}
                onClick={(newTab) => props.onOpenNote(note.id, newTab)}
                selecting={props.selecting}
                selected={props.selectedNotes?.has(note.id) ?? false}
                onToggleSelect={props.onToggleSelect}
                lingui={props.lingui}
              />
            )}
          </For>
        </Show>
      </Show>
    </section>
  )
}

const NOTES_LIST_RESOURCE = "notes:list"

export function NotePanel(props: { tab?: WorkbenchPanelTab } = {}) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const params = useParams()
  const directory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const lingui = useLingui()
  const workbench = useWorkbenchPanels()

  const noteDocuments = useNoteDocuments()
  const navigation = noteDocuments.navigation(directory() ?? HOME_SCOPE_KEY)
  const [navigator, setNavigator] = createSignal<WorkspaceNavigatorController>()

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
  const [listOptionsOpen, setListOptionsOpen] = createSignal(false)

  const currentScopeID = createMemo(() => {
    const dir = directory()
    if (!dir || dir === "home") return "home"
    return resolveProjectScope(dir, undefined, globalSync.data.scope)?.id ?? ""
  })

  const scopeLookup = createMemo(() => {
    const map = new Map<string, { name: string; directory: string }>()
    map.set("home", { name: getScopeLabel(undefined, "home"), directory: "home" })
    for (const scope of globalSync.data.scope) {
      map.set(scope.id, {
        name: getScopeLabel(scope),
        directory: scope.id,
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
          sdk.client.note.listMeta({ scopeID: dir, archived: "false" }),
          sdk.client.note.listMeta({ scopeID: dir, archived: "true" }),
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
      const result = await sdk.client.note.listMeta({ scopeID: dir, archived: "false" })
      return (result.data ?? []) as NoteMetaScopeGroup[]
    },
  )

  const [loops, { mutate: mutateLoops }] = createResource(
    () => ({ dir: directory(), reconnect: globalSync.reconnectVersion() }),
    async ({ dir }) => {
      if (!dir) return [] as BlueprintLoopInfo[]
      try {
        const result = await sdk.client.blueprint.loop.list({ scopeID: dir })
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
            name:
              meta?.name ??
              (g.scopeID === "home"
                ? getScopeLabel(undefined, "home")
                : lingui._({ id: "note.scope.archivedProject", message: "Archived project" })),
            directory: groupDirectory,
            isCurrent,
          }
        }
        archived.push(...archivedMember)
        sortNotes(activeMember)
        return {
          ...g,
          notes: activeMember,
          name:
            meta?.name ??
            (g.scopeID === "home"
              ? getScopeLabel(undefined, "home")
              : lingui._({ id: "note.scope.archivedProject", message: "Archived project" })),
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
        name: lingui._({ id: "note.scope.archived", message: "Archived" }),
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

  async function openNote(id: string, dir: string, newTab = false) {
    if (!dir) return
    if (props.tab) {
      const opened = await workbench.openPanel("notes", {
        replaceCurrent: !newTab,
        forceNew: newTab,
        init: {
          resourceId: id,
          source: dir,
          title:
            rawGroups()
              ?.flatMap((group) => group.notes)
              .find((note) => note.id === id)?.title || lingui._(N.untitled),
        },
      })
      if (opened) navigator()?.closeDrawer()
      return
    }
    setSelectedNoteId(id)
    setSelectedNoteDir(dir)
    setView("editor")
  }

  function showNoteList() {
    setView("list")
    if (props.tab) workbench.updateTab(props.tab.id, { resourceId: NOTES_LIST_RESOURCE })
  }

  createEffect(
    on(
      () => [props.tab?.resourceId, props.tab?.source] as const,
      ([id, source]) => {
        if (!id || id === NOTES_LIST_RESOURCE) {
          setView("list")
          return
        }
        setSelectedNoteId(id)
        setSelectedNoteDir(source || directory() || HOME_SCOPE_KEY)
        setView("editor")
      },
    ),
  )

  async function createNoteInScope(dir: string) {
    if (!dir) return
    try {
      const result = await sdk.client.note.create({
        scopeID: dir,
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
          await sdk.client.note.batch({ ids, action: "archive", scopeID: directory() })
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
          await sdk.client.note.batch({ ids, action: "unarchive", scopeID: directory() })
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
          await sdk.client.note.batch({ ids, action: "delete", scopeID: directory() })
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
          <div class="note-workspace-toolbar">
            <span class="note-workspace-owner">{lingui._(P.notes)}</span>
            <IconButton
              icon={getSemanticIcon("action.add")}
              variant="ghost"
              onClick={() => void createNoteInScope(directory() ?? HOME_SCOPE_KEY)}
              aria-label={lingui._(N.newNote)}
            />
            <Popover
              open={listOptionsOpen()}
              onOpenChange={setListOptionsOpen}
              placement="bottom-end"
              class="note-toolbar-popover"
              triggerAs={(triggerProps) => (
                <IconButton
                  {...triggerProps}
                  icon={getSemanticIcon("action.more")}
                  variant="ghost"
                  aria-label={lingui._({ id: "note.list.options", message: "Notes list options" })}
                  aria-haspopup="menu"
                />
              )}
            >
              <div class="note-toolbar-menu" role="menu" onKeyDown={resourceMenuKeyDown}>
                <For each={filterOptions()}>
                  {(option) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={kindFilter() === option.value}
                      onClick={() => {
                        setKindFilter(option.value)
                        setListOptionsOpen(false)
                      }}
                    >
                      <span>{option.label}</span>
                      <small>{option.count}</small>
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={showArchived()}
                  onClick={() => {
                    setShowArchived((value) => !value)
                    setListOptionsOpen(false)
                  }}
                >
                  <Icon name={getSemanticIcon("notes.archive")} size="small" />
                  <span>{lingui._(showArchived() ? N.showActive : N.showArchived)}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={selecting()}
                  onClick={() => {
                    setSelecting(true)
                    setListOptionsOpen(false)
                  }}
                >
                  <Icon name={getSemanticIcon("notes.select")} size="small" />
                  <span>{lingui._(N.selectNotes)}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void refetch()
                    setListOptionsOpen(false)
                  }}
                >
                  <Icon name={getSemanticIcon("action.refresh")} size="small" />
                  <span>{lingui._(N.refresh)}</span>
                </button>
              </div>
            </Popover>
          </div>
          <div class="note-list-search">
            <Icon name={getSemanticIcon("notes.search")} size="small" />
            <input
              type="search"
              aria-label={lingui._(N.searchNotes)}
              placeholder={lingui._(N.searchNotes)}
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <Show when={search()}>
              <IconButton
                icon={getSemanticIcon("action.close")}
                variant="ghost"
                aria-label={lingui._(N.clearSearch)}
                onClick={() => setSearch("")}
              />
            </Show>
          </div>
          <Show when={kindFilter() !== "all" || showArchived()}>
            <div class="note-list-filter-status">
              <span>
                {filterOptions().find((option) => option.value === kindFilter())?.label}
                {showArchived() ? ` · ${lingui._({ id: "note.scope.archived", message: "Archived" })}` : ""}
              </span>
              <button
                type="button"
                onClick={() => {
                  setKindFilter("all")
                  setShowArchived(false)
                }}
              >
                {lingui._({ id: "note.list.clearFilters", message: "Clear filters" })}
              </button>
            </div>
          </Show>

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
            <Show when={rawGroups.error}>
              <div role="alert" class="note-document-error">
                <span>{requestErrorMessage(rawGroups.error)}</span>
                <button type="button" onClick={() => void refetch()}>
                  {lingui._({ id: "note.document.retry", message: "Retry" })}
                </button>
              </div>
            </Show>
            <Show when={rawGroups.loading}>
              <div class="py-4">
                <NoteCardSkeleton />
                <NoteCardSkeleton />
                <NoteCardSkeleton />
              </div>
            </Show>
            <Show when={!rawGroups.loading && !rawGroups.error}>
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
                        onOpenNote={(id, newTab) => openNote(id, group.directory, newTab)}
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
        {(_resource) => (
          <div class="note-workspace-editor-layout">
            <WorkspaceNavigator
              label={lingui._(P.notes)}
              open={navigation.state.open}
              width={navigation.state.width}
              onResize={navigation.setWidth}
              onReady={setNavigator}
              onOpen={() => navigation.setOpen(true)}
              onClose={() => navigation.setOpen(false)}
            >
              <div class="note-navigation-search">
                <input
                  type="search"
                  aria-label={lingui._({ id: N.searchNotes.id, message: N.searchNotes.message })}
                  placeholder={lingui._({ id: N.searchNotes.id, message: N.searchNotes.message })}
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
                <IconButton
                  icon={getSemanticIcon("action.add")}
                  variant="ghost"
                  onClick={() => void createNoteInScope(directory() ?? HOME_SCOPE_KEY)}
                  aria-label={lingui._({ id: N.newNote.id, message: N.newNote.message })}
                />
              </div>
              <div class="note-navigation-list">
                <Show when={rawGroups.error}>
                  <div role="alert" class="note-navigation-message">
                    {requestErrorMessage(rawGroups.error)}
                    <button type="button" onClick={() => void refetch()}>
                      {lingui._({ id: N.refresh.id, message: N.refresh.message })}
                    </button>
                  </div>
                </Show>
                <Show when={rawGroups.loading}>
                  <Spinner class="size-4" />
                </Show>
                <For
                  each={displayGroups()}
                  fallback={
                    <Show when={!rawGroups.loading && !rawGroups.error}>
                      <div class="note-navigation-message">
                        {lingui._({ id: N.noNotesFound.id, message: N.noNotesFound.message })}
                      </div>
                    </Show>
                  }
                >
                  {(group) => (
                    <section>
                      <button
                        type="button"
                        class="note-navigation-group"
                        aria-expanded={isExpanded(group.scopeID, group.isCurrent)}
                        onClick={() => toggleExpanded(group.scopeID, group.isCurrent)}
                      >
                        <Icon
                          name={getSemanticIcon(
                            isExpanded(group.scopeID, group.isCurrent) ? "navigation.collapse" : "navigation.expand",
                          )}
                          size="small"
                        />
                        <span>{group.name}</span>
                      </button>
                      <Show when={isExpanded(group.scopeID, group.isCurrent)}>
                        <For each={group.notes}>
                          {(item) => (
                            <div
                              class="note-navigation-row"
                              classList={{ "note-navigation-row--blueprint": isBlueprintNote(item) }}
                            >
                              <button
                                type="button"
                                class="note-navigation-document"
                                aria-current={
                                  selectedNoteId() === item.id && selectedNoteDir() === group.directory
                                    ? "page"
                                    : undefined
                                }
                                title={item.title}
                                draggable
                                onDragStart={(event) => attachNoteDragData(event, item)}
                                onClick={() => void openNote(item.id, group.directory)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                    event.preventDefault()
                                    void openNote(item.id, group.directory, true)
                                  }
                                }}
                              >
                                <Icon
                                  name={getSemanticIcon(isBlueprintNote(item) ? "blueprint.main" : "notes.main")}
                                  size="small"
                                />
                                <span class="note-navigation-copy">
                                  <span>
                                    {item.title || lingui._({ id: N.untitled.id, message: N.untitled.message })}
                                  </span>
                                  <Show when={isBlueprintNote(item)}>
                                    <small>
                                      {getBlueprintVisualState(lingui, item, loopsByNote().get(item.id)).label}
                                    </small>
                                  </Show>
                                </span>
                              </button>
                              <IconButton
                                icon={getSemanticIcon("action.open")}
                                variant="ghost"
                                onClick={() => void openNote(item.id, group.directory, true)}
                                aria-label={lingui._({ id: "workspace.document.newTab", message: "Open in new tab" })}
                              />
                            </div>
                          )}
                        </For>
                      </Show>
                    </section>
                  )}
                </For>
              </div>
            </WorkspaceNavigator>
            <Show when={JSON.stringify([selectedNoteDir(), selectedNoteId()])} keyed>
              {(_resource) => (
                <NoteEditor
                  id={selectedNoteId()!}
                  directory={selectedNoteDir() ?? directory() ?? "home"}
                  onBack={() => navigator()?.toggle()}
                  navigationOpen={navigator()?.opened}
                  navigationId={navigator()?.id}
                  onDelete={() => {
                    if (props.tab) void workbench.closeTab(props.tab.id)
                    else showNoteList()
                  }}
                  loops={loopsByNote().get(selectedNoteId()!) ?? []}
                  tab={props.tab}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

function NoteEditor(props: {
  id: string
  directory: string
  loops: BlueprintLoopInfo[]
  onBack: () => void
  navigationOpen?: () => boolean
  navigationId?: string
  onDelete: () => void
  tab?: WorkbenchPanelTab
}) {
  const noteID = props.id
  const scopeID = props.directory
  const tab = props.tab ? { ...props.tab } : undefined
  const sdk = useGlobalSDK()
  const client = sdk.client
  const serverURL = sdk.url
  const globalSync = useGlobalSync()
  const sync = useSync()
  const data = useData()
  const platform = usePlatform()
  const params = useParams()
  const confirm = useConfirm()
  const directory = () => scopeID
  const { fmt } = useLocale()
  const lingui = useLingui()

  const [note, { refetch }] = createResource(
    () => ({ id: noteID, dir: directory(), reconnect: globalSync.reconnectVersion() }),
    async ({ id, dir }) => {
      if (!dir) return null
      const result = await client.note.get({ id, scopeID: dir })
      return result.data as NoteInfo
    },
  )

  const documents = useNoteDocuments()
  const doc = documents.get(scopeID, noteID)
  onCleanup(documents.retain(scopeID, noteID))
  const workbench = useWorkbenchPanels()
  const sessionKey = workbench.sessionKey()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const isCurrent = () =>
    !disposed &&
    sessionKey === workbench.sessionKey() &&
    (!tab ||
      workbench
        .surface("side")
        .tabs()
        .some(
          (item) =>
            item.id === tab.id && item.panelId === "notes" && item.resourceId === noteID && item.source === scopeID,
        ))
  const baseNote = doc.base
  const title = doc.title
  const tags = doc.tags
  const saving = doc.saving
  const conflict = doc.conflict
  const [tagInput, setTagInput] = createSignal("")
  const [editor, setEditor] = createSignal<Editor>()
  const [convertingBlueprint, setConvertingBlueprint] = createSignal(false)
  const [runningBlueprint, setRunningBlueprint] = createSignal(false)
  const [showRunMenu, setShowRunMenu] = createSignal(false)
  const [moreOpen, setMoreOpen] = createSignal(false)

  const noteLoaded = createMemo(() => !!baseNote())
  const isBlueprint = createMemo(() => baseNote()?.kind === "blueprint")
  const routeDirectory = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const blueprintScopes = createMemo(() => globalSync.data.scope)
  const canRunCurrentSession = createMemo(() =>
    canRunBlueprintInCurrentSession({
      sessionID: params.id,
      blueprintScopeID: directory(),
      sessionScopeID: routeDirectory(),
    }),
  )
  const canRunWorktreeSession = createMemo(() =>
    canCreateBlueprintWorktree({
      scopeID: directory(),
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

  const flushSave = doc.flush
  const saveMetadata = doc.mutate

  function handleEditorReady(instance: Editor) {
    setEditor(instance)
  }

  createEffect(() => {
    const incoming = note()
    if (incoming) doc.ingest(incoming)
    if (note.error && isNoteNotFoundError(note.error)) doc.markDeleted()
  })
  createEffect(() => {
    const instance = editor()
    const content = doc.content()
    if (!instance || instance.isDestroyed || !shouldReplaceEditorContent(instance.getJSON(), content)) return
    const selection = instance.state.selection
    instance.commands.setContent(content as Parameters<Editor["commands"]["setContent"]>[0], { emitUpdate: false })
    const size = instance.state.doc.content.size
    instance.commands.setTextSelection({ from: Math.min(selection.from, size), to: Math.min(selection.to, size) })
  })
  createEffect(() => {
    if (!tab || !noteLoaded()) return
    workbench.updateTab(tab.id, { title: title() || lingui._(N.untitled), dirty: hasDirtyFields(doc.dirty()) })
  })
  if (tab) onCleanup(workbench.beforeClose(tab.id, doc.flush))
  const unsubEditorNoteEvents = sdk.event.listen((entry: { name?: string; details: SynergyEvent }) => {
    const event = entry.details
    if (entry.name && entry.name !== scopeID) return
    if (event.type === "note.updated" && event.properties.note.id === noteID)
      doc.ingest(event.properties.note, event.properties.changed)
    if (event.type === "note.deleted" && event.properties.id === noteID) doc.markDeleted()
  })
  onCleanup(unsubEditorNoteEvents)

  async function handleBack() {
    isCurrent() && props.onBack()
  }

  function addTag(tag: string) {
    const t = tag.trim().toLowerCase()
    if (!t || tags().includes(t)) return
    doc.edit("tags", [...tags(), t])
    setTagInput("")
  }

  function removeTag(tag: string) {
    doc.edit(
      "tags",
      tags().filter((t) => t !== tag),
    )
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
    const res = await client.asset.upload({ file })
    return assetHttpUrl(serverURL, res.data as { id?: string; url?: string } | undefined)
  }

  function onTitleInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    doc.edit("title", e.currentTarget.value)
  }

  async function togglePin() {
    if (!(await flushSave())) return
    const current = baseNote()
    if (!current) return
    const pinned = !current.pinned
    await saveMetadata((base) => ({ pinned, expectedVersion: base.version }))
  }

  async function toggleGlobal() {
    if (!(await flushSave())) return
    const current = baseNote()
    if (!current) return
    const global = !current.global
    await saveMetadata((base) => ({ global, expectedVersion: base.version }))
  }

  const reloadRemote = doc.reloadRemote
  const overwriteRemote = doc.overwriteRemote

  async function downloadNote() {
    const dir = directory()
    if (!dir) return
    if (!(await flushSave())) return
    const params = new URLSearchParams({ scopeID: dir, format: "md" })
    const url = `${serverURL}/note/export/${encodeURIComponent(noteID)}?${params}`
    const a = document.createElement("a")
    a.href = url
    a.download = ""
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function downloadDraft() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ title: title(), tags: tags(), content: doc.content() }, null, 2)], {
        type: "application/json",
      }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${(title() || "note").replace(/[\\/:*?"<>|]/g, "_").slice(0, 128)}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  async function convertToBlueprint() {
    if (isBlueprint() || convertingBlueprint()) return
    setConvertingBlueprint(true)
    try {
      await saveMetadata((base) => ({ kind: "blueprint", blueprint: {}, expectedVersion: base.version }))
    } finally {
      setConvertingBlueprint(false)
    }
  }
  async function convertToNote() {
    if (!isBlueprint() || convertingBlueprint()) return
    const base = baseNote()
    if (!base || base.blueprint?.activeLoopID || noteLoops().some((loop) => isActiveBlueprintLoopStatus(loop.status)))
      return
    setConvertingBlueprint(true)
    try {
      await saveMetadata((base) => ({ kind: "note", expectedVersion: base.version }))
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
      baseUrl: serverURL,
      fetch: platform.fetch,
      scopeID: directory,
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

  async function runBlueprint(
    mode: BlueprintRunMode,
    executionAgent: string,
    model?: { providerID: string; modelID: string },
  ) {
    const dir = directory()
    if (!dir || runningBlueprint()) return
    if (!(await flushSave())) return
    let base = baseNote()
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
      if (base.blueprint?.defaultAgent !== executionAgent) {
        const saved = await saveMetadata((current) => blueprintExecutionAgentPatch(current, executionAgent))
        if (!saved) return
        base = baseNote()
        if (!base) return
      }

      target = await createExecutionSession(mode, dir)
      if (!target) return
      const loop = await client.blueprint.loop
        .create({
          scopeID: dir,
          blueprintLoopCreateInput: {
            noteID: base.id,
            noteVersion: base.version,
            title: base.title || "Blueprint run",
            description: base.blueprint?.description,
            sessionID: target.sessionID,
            runMode: mode,
            executionAgent,
            ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          },
        })
        .then((result) => result.data)
      if (!loop?.id) throw new Error("Failed to create BlueprintLoop")
      createdLoopID = loop.id
      await client.blueprint.loop.start({ id: loop.id, scopeID: dir })
      setShowRunMenu(false)
    } catch (error) {
      if (createdLoopID) {
        await client.blueprint.loop.cancel({ id: createdLoopID, scopeID: dir }).catch(() => undefined)
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
    if (!(await flushSave())) return
    confirm.show({
      ...archiveNoteConfirm(1),
      onConfirm: async () => {
        await client.note.batch({ ids: [noteID], action: "archive", scopeID: dir })
        isCurrent() && props.onBack()
      },
    })
  }

  async function restoreNote() {
    const dir = directory()
    if (!dir) return
    if (!(await flushSave())) return
    await client.note.batch({ ids: [noteID], action: "unarchive", scopeID: dir })
  }

  async function deleteArchivedNote() {
    const dir = directory()
    if (!dir) return
    confirm.show({
      ...deleteArchivedNoteConfirm(1),
      onConfirm: async () => {
        await client.note.batch({ ids: [noteID], action: "delete", scopeID: dir })
        isCurrent() && props.onDelete()
      },
    })
  }

  let conflictBannerEl: HTMLDivElement | undefined

  function handleRunBlueprint() {
    setShowRunMenu(true)
  }

  return (
    <div class="note-workspace-document flex h-full min-w-0 flex-1 flex-col bg-background-base">
      <style>{TIPTAP_STYLES}</style>

      <div class="border-b border-border-weaker-base/40">
        <div class="note-workspace-toolbar">
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-lg text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base transition-colors"
            onClick={handleBack}
            aria-label={
              props.navigationOpen?.()
                ? lingui._({ id: "note.navigation.hide", message: "Hide notes list" })
                : lingui._({ id: "note.navigation.show", message: "Show notes list" })
            }
            aria-expanded={props.navigationOpen?.() ?? false}
            aria-controls={props.navigationId}
            data-workspace-navigation-toggle
          >
            <Icon name={getSemanticIcon("notes.main")} size="small" />
          </button>
          <span class="note-workspace-owner">
            {getScopeLabel(
              globalSync.data.scope.find((scope) => scope.id === directory()),
              directory(),
            )}
          </span>
          <span class="note-workspace-save" role="status">
            {doc.deleted() || (!noteLoaded() && note.error)
              ? lingui._({ id: "note.document.unavailable", message: "Unavailable" })
              : !noteLoaded()
                ? lingui._({ id: "note.document.loading", message: "Loading…" })
                : saving()
                  ? lingui._({ id: "note.document.saving", message: "Saving…" })
                  : hasDirtyFields(doc.dirty())
                    ? lingui._({ id: "note.document.unsaved", message: "Unsaved changes" })
                    : lingui._({ id: "note.document.saved", message: "Saved" })}
          </span>
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
          <Popover
            open={moreOpen()}
            onOpenChange={setMoreOpen}
            placement="bottom-end"
            class="note-toolbar-popover"
            triggerAs={(triggerProps) => (
              <IconButton
                {...triggerProps}
                icon={getSemanticIcon("action.more")}
                variant="ghost"
                aria-label={lingui._({ id: "note.document.more", message: "Note options" })}
                aria-haspopup="menu"
              />
            )}
          >
            <div class="note-toolbar-menu" role="menu" onKeyDown={resourceMenuKeyDown}>
              <For
                each={[
                  { label: lingui._(N.downloadNote), icon: getSemanticIcon("action.download"), run: downloadNote },
                  ...(hasDirtyFields(doc.dirty())
                    ? [
                        {
                          label: lingui._({ id: "note.document.exportDraft", message: "Export draft" }),
                          icon: getSemanticIcon("action.download"),
                          run: downloadDraft,
                        },
                      ]
                    : []),
                  {
                    label: lingui._(baseNote()?.pinned ? N.unpin : N.pin),
                    icon: getSemanticIcon("notes.pin"),
                    run: togglePin,
                  },
                  {
                    label: lingui._(isBlueprint() ? N.convertToNote : N.convertToBlueprint),
                    icon: getSemanticIcon("blueprint.main"),
                    disabled: convertingBlueprint(),
                    run: isBlueprint() ? convertToNote : convertToBlueprint,
                  },
                  ...(baseNote()?.global !== undefined
                    ? [
                        {
                          label: lingui._(baseNote()?.global ? N.makeLocal : N.makeGlobal),
                          icon: getSemanticIcon("navigation.home"),
                          run: toggleGlobal,
                        },
                      ]
                    : []),
                  {
                    label: lingui._({ id: "note.document.close", message: "Close note" }),
                    icon: getSemanticIcon("action.close"),
                    run: () => {
                      if (isCurrent()) props.onDelete()
                    },
                  },
                  {
                    label: lingui._(isArchived() ? N.restore : N.archive),
                    icon: getSemanticIcon("notes.archive"),
                    run: isArchived() ? restoreNote : archiveNote,
                  },
                  ...(isArchived()
                    ? [
                        {
                          label: lingui._(N.deletePermanently),
                          icon: getSemanticIcon("action.remove"),
                          run: deleteArchivedNote,
                        },
                      ]
                    : []),
                ]}
              >
                {(action) => (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    onClick={() => {
                      setMoreOpen(false)
                      void action.run()
                    }}
                  >
                    <Icon name={action.icon} size="small" />
                    <span>{action.label}</span>
                  </button>
                )}
              </For>
            </div>
          </Popover>
        </div>

        <Show when={conflict()}>
          <div
            ref={conflictBannerEl}
            class="flex items-center gap-2 border-t border-text-diff-delete-base/15 bg-text-diff-delete-base/8 px-4 py-2"
          >
            <span class="flex-1 text-11-regular text-text-diff-delete-base">
              {lingui._({
                id: "note.document.conflict",
                message: "This note changed elsewhere. Review the remote version or keep your draft.",
              })}
            </span>
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
                  ? lingui._({
                      id: N.runsCount.id,
                      message: N.runsCount.message,
                      values: { count: getRunCount(baseNote()!, noteLoops()) },
                    })
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

      <Show when={doc.backupUnavailable() && hasDirtyFields(doc.dirty())}>
        <div class="note-document-error" role="alert">
          <span>
            {lingui._({
              id: "note.document.backupFailed",
              message: "Local backup is unavailable. Keep this window open until your changes are saved.",
            })}
          </span>
          <button type="button" onClick={() => doc.persist()}>
            {lingui._({ id: "note.document.retry", message: "Retry" })}
          </button>
        </div>
      </Show>
      <Show when={doc.error() || doc.deleted()}>
        <div class="note-document-error" role="alert">
          <span>
            {doc.deleted()
              ? lingui._({ id: "note.document.deleted", message: "This note was deleted. Your draft is preserved." })
              : lingui._({
                  id: "note.document.saveFailed",
                  message: "Changes could not be saved. Your draft is preserved.",
                })}
          </span>
          <button type="button" onClick={() => void (doc.deleted() ? refetch() : doc.flush())}>
            {lingui._({ id: "note.document.retry", message: "Retry" })}
          </button>
        </div>
      </Show>

      <Show when={!noteLoaded()}>
        <div class="flex flex-1 items-center justify-center">
          <Show when={note.error || doc.deleted()} fallback={<Spinner class="size-4" />}>
            <div role="alert" class="note-document-error">
              <span>
                {requestErrorMessage(note.error) ||
                  lingui._({ id: "note.document.unavailable", message: "Unavailable" })}
              </span>
              <button type="button" onClick={() => void refetch()}>
                {lingui._({ id: "note.document.retry", message: "Retry" })}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={noteLoaded()}>
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="note-document-heading">
            <input
              type="text"
              class="w-full border-none bg-transparent text-16-medium text-text-strong outline-none placeholder:text-text-weaker"
              placeholder={lingui._({ id: N.untitled.id, message: N.untitled.message })}
              aria-label={lingui._({ id: "note.document.title", message: "Note title" })}
              value={title()}
              onInput={onTitleInput}
            />
          </div>

          <div class="note-document-body">
            <DocumentEditorCore
              content={doc.content()}
              retained={doc.view}
              onPositionChange={doc.persist}
              onUpdate={() => {
                const instance = editor()
                if (instance) doc.edit("content", instance.getJSON())
              }}
              onEditorReady={handleEditorReady}
              uploadFile={uploadFile}
              sdkClient={client}
              sdkUrl={serverURL}
              saving={saving()}
            />
          </div>

          <div class="note-document-tags flex shrink-0 flex-wrap items-center gap-1.5">
            <For each={tags()}>
              {(tag) => (
                <span class="inline-flex items-center gap-1 rounded-full bg-surface-inset-base px-2.5 py-1 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/35">
                  {tag}
                  <button
                    type="button"
                    class="flex size-3 items-center justify-center rounded-full text-text-weaker hover:text-text-base"
                    onClick={() => removeTag(tag)}
                    aria-label={lingui._({ id: "note.tag.remove", message: "Remove tag {tag}", values: { tag } })}
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
              aria-label={lingui._(N.addTags)}
              value={tagInput()}
              onInput={(e) => setTagInput(e.currentTarget.value)}
              onKeyDown={handleTagKeyDown}
            />
          </div>
        </div>
      </Show>

      <Show when={showRunMenu() && activeBlueprintRun() === undefined}>
        <RunMenu
          agents={sync.data.agent}
          title={baseNote()?.title ?? lingui._(N.untitled)}
          executionAgent={baseNote()?.blueprint?.defaultAgent}
          canRunInCurrentSession={canRunCurrentSession()}
          canCreateWorktree={canRunWorktreeSession()}
          onRun={runBlueprint}
          onClose={() => setShowRunMenu(false)}
        />
      </Show>
    </div>
  )
}
