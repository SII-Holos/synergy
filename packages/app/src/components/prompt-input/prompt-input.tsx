import type { BlueprintLoopInfo } from "@ericsanchezok/synergy-sdk/client"
import { useFilteredList } from "@ericsanchezok/synergy-ui/hooks"
import {
  createEffect,
  on,
  Component,
  Show,
  For,
  onMount,
  onCleanup,
  Switch,
  Match,
  createMemo,
  createSignal,
  createResource,
  untrack,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useLocal } from "@/context/local"
import { useInput, type ControlProfileId } from "@/context/input"
import { useFile } from "@/context/file"
import {
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  sanitizePrompt,
  usePrompt,
  UploadedAttachmentPart,
  NoteAttachmentPart,
  SessionAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSessionTransition } from "@/context/session-transition"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { LatticeConfigDialog, type LatticeEnableConfig } from "@/components/lattice/lattice-config-dialog"
import { LatticePanel } from "@/components/lattice/lattice-panel"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { List } from "@ericsanchezok/synergy-ui/list"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getAgentVisual } from "@/components/agent-visual"
import type { Message } from "@ericsanchezok/synergy-sdk/client"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { QuickActions } from "./quick-actions"
import { isHomeScope } from "@/utils/scope"
import { computeWorkingPhrase, titlecaseStatusLabel } from "@ericsanchezok/synergy-ui/session-status"
import { SessionAgendaWakeIndicator } from "@/components/session/wake-indicator"
import { FILE_INPUT_ACCEPT } from "@/components/prompt-input/files"
import { permissionModeVisual } from "@/components/prompt-input/permission-modes"
import { PLACEHOLDERS, PLACEHOLDERS_GLOBAL } from "@/components/prompt-input/placeholders"
import type {
  AtOption,
  BlueprintSlot,
  PromptInputProps,
  PromptInputStore,
  SlashCommand,
} from "@/components/prompt-input/types"
import { PromptAttachments } from "@/components/prompt-input/attachments"
import { PromptPopover } from "@/components/prompt-input/popover"
import { PermissionModeSelector } from "@/components/prompt-input/permission-selector"
import { PromptAddMenu, type PromptAddMenuSection } from "@/components/prompt-input/add-menu"
import { PromptStartModeSelector, type PromptStartOptionGroup } from "@/components/prompt-input/start-options"
import { usePromptSubmit } from "@/components/prompt-input/submit"
import { usePromptAttachments } from "@/components/prompt-input/attachments-hook"
import { usePromptEditor } from "@/components/prompt-input/editor-hook"
import { sendSessionCommand } from "@/components/prompt-input/session-command"
import { inlineLength, inlineText } from "@/components/prompt-input/content"
import { canSubmitPrompt } from "@/components/prompt-input/submit-intent"
import { getCursorPosition, setCursorPosition } from "@/components/prompt-input/editor-dom"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { resolveLatticeWorkflowMenuState } from "@/components/prompt-input/workflow-menu"
import {
  blueprintRequestErrorMessage,
  isTerminalBlueprintLoopStatus,
  resolveBlueprintSlotDisplay,
  type BlueprintSlotDisplay,
} from "@/components/prompt-input/blueprint-slot"
import { isWorktreeWorkspaceSelection, worktreeOptionSelection } from "@/components/session/worktree-session"
import { restoreNewSessionRecovery } from "@/components/session/new-session-recovery"
import { PlanBlueprintOfferControl } from "@/components/prompt-input/plan-blueprint-offer"
import { emptyPlanBlueprintOfferState, shouldDisplayPlanBlueprintOffer } from "@/context/plan-blueprint-offer"
import { ComposerSlotOutlet } from "@ericsanchezok/synergy-ui/composer-slots"
import { useLocale } from "@/context/locale"
import { translateDescriptor } from "@/locales/translate"
import { PI } from "./prompt-input-i18n"
import { EditLightLoopDialog } from "./edit-light-loop-dialog"
import { LightLoopSubmitControl } from "./light-loop-submit-control"
import { WorktreeUnavailableDialog } from "./worktree-unavailable-dialog"
import { ComposerDocumentController } from "./composer-document"
import { ComposerExtensionOutlet } from "@/plugin/registries/composer-extension-registry"

function sanitizePromptHistory(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  const entries = (value as { entries?: unknown }).entries
  return {
    ...value,
    entries: Array.isArray(entries) ? entries.map(sanitizePrompt) : [],
  }
}

function WorkflowChip(props: {
  label: string
  ariaLabel: string
  tooltip: string
  icon: IconName
  working: () => boolean
  onCancel: () => void | Promise<void>
}) {
  const { controller, i18n } = useLocale()
  const blockedTooltip = () => {
    controller.activeLocale()
    return i18n._(PI.stopBeforeChange)
  }
  const handleClick = (event: MouseEvent) => {
    if (!props.working()) {
      void props.onCancel()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    showToast({
      type: "warning",
      title: i18n._(PI.sessionRunning),
      description: blockedTooltip(),
    })
  }

  return (
    <Tooltip placement="top" value={props.working() ? blockedTooltip() : props.tooltip}>
      <button
        type="button"
        aria-label={props.ariaLabel}
        aria-disabled={props.working()}
        class="prompt-input-toolbar-button prompt-input-compact-control group flex items-center gap-1.5 text-text-weak"
        classList={{
          "hover:text-text-base": !props.working(),
          "opacity-60 cursor-not-allowed": props.working(),
        }}
        onClick={handleClick}
      >
        <span class="relative flex size-4 shrink-0 items-center justify-center">
          <span
            class="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity"
            classList={{ "group-hover:opacity-0": !props.working() }}
          >
            <Icon name={props.icon} size="small" class="text-icon-weak-base" />
          </span>
          <span
            class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity"
            classList={{ "group-hover:opacity-100": !props.working() }}
          >
            <Icon name={getSemanticIcon("action.close")} size="small" class="text-icon-base" />
          </span>
        </span>
        <span class="prompt-input-compact-label text-12-medium leading-none">{props.label}</span>
      </button>
    </Tooltip>
  )
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const workflowDialog = useDialog()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const input = useInput()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const params = useParams()
  const command = useCommand()
  const sessionTransition = useSessionTransition()
  const { controller, i18n } = useLocale()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const [localArmedLoop, setLocalArmedLoop] = createSignal<BlueprintSlot | null>(null)
  const [blueprintLoading, setBlueprintLoading] = createSignal(false)
  const [newSessionSubmitPending, setNewSessionSubmitPending] = createSignal(false)
  const idle = { type: "idle" as const }
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const sendShortcut = createMemo(() => input.sendShortcut())
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const activeWorkflow = createMemo(() => (params.id ? info()?.workflow : undefined))
  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? idle)
  const working = createMemo(() => status()?.type !== "idle")
  const [pendingPlan, setPendingPlan] = createSignal(false)
  const [pendingLattice, setPendingLattice] = createSignal<{
    mode: "auto" | "collaborative"
    maxModelCalls: number
  } | null>(null)
  const [pendingLightLoop, setPendingLightLoop] = createSignal(false)
  const storedLightLoop = createMemo(() =>
    params.id ? activeWorkflow()?.kind === "lightloop" || pendingLightLoop() : pendingLightLoop(),
  )
  const blueprintModeLocked = createMemo(() => !!localArmedLoop() || !!info()?.blueprint?.loopID)
  const lightLoopActive = createMemo(() => !blueprintModeLocked() && storedLightLoop())
  const lightLoopInstructions = createMemo(() => {
    const workflow = activeWorkflow()
    return params.id && workflow?.kind === "lightloop" ? workflow.instructions : undefined
  })
  const persistedLightLoopActive = createMemo(() => activeWorkflow()?.kind === "lightloop")
  const lightLoopReviewPending = createMemo(() => {
    const workflow = activeWorkflow()
    return workflow?.kind === "lightloop" && !!workflow.stopRequest
  })
  const storedPlan = createMemo(() => (params.id ? activeWorkflow()?.kind === "plan" : pendingPlan()))
  const planActive = createMemo(() => !blueprintModeLocked() && storedPlan())
  const sessionScopeDirectory = createMemo(() => {
    const scope = info()?.scope
    if (!scope || typeof scope !== "object") return undefined
    if (!("directory" in scope) || typeof scope.directory !== "string") return undefined
    return scope.directory
  })
  const blueprintLoopRequest = (loopID: string, directory = sessionScopeDirectory()) =>
    directory ? { id: loopID, directory } : { id: loopID }

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (id) {
          setPendingPlan(false)
          setPendingLattice(null)
          setPendingLightLoop(false)
        }
      },
    ),
  )

  const sessionLoopSource = createMemo(() => {
    const loopID = params.id ? info()?.blueprint?.loopID : undefined
    if (!loopID) return null
    // Track reconnectVersion so the loop refetches after a backend restart,
    // whose in-memory state the server cannot replay via events (issue #331).
    return { loopID, directory: sessionScopeDirectory(), reconnect: globalSync.reconnectVersion() }
  })

  const [sessionLoop, { mutate: mutateSessionLoop }] = createResource(
    sessionLoopSource,
    async ({ loopID, directory }) => {
      if (!loopID) return null
      try {
        const result = await sdk.client.blueprint.loop.get(blueprintLoopRequest(loopID, directory))
        return (result.data as BlueprintLoopInfo) ?? null
      } catch {
        return null
      }
    },
  )

  createEffect(
    on(
      sessionLoopSource,
      (source) => {
        const loop = untrack(sessionLoop)
        if (!source || (loop && loop.id !== source.loopID)) mutateSessionLoop(null)
      },
      { defer: true },
    ),
  )

  const getBlueprintSlotStatusLabel = (status: string) => {
    switch (status) {
      case "pending":
        return i18n._(PI.bpSlotReady)
      case "armed":
        return i18n._(PI.bpSlotEquipped)
      case "running":
        return i18n._(PI.bpSlotRunning)
      case "waiting":
        return i18n._(PI.bpSlotWaiting)
      case "auditing":
        return i18n._(PI.bpSlotAuditing)
      case "completed":
        return i18n._(PI.bpSlotCompleted)
      case "failed":
        return i18n._(PI.bpSlotFailed)
      case "cancelled":
        return i18n._(PI.bpSlotCancelled)
      default:
        return titlecaseStatusLabel(status)
    }
  }

  const getBlueprintSlotIconClass = (status: string) => {
    switch (status) {
      case "armed":
      case "pending":
        return "text-text-interactive-base"
      case "running":
        return "text-text-on-success-base"
      case "auditing":
        return "text-text-on-warning-base"
      case "completed":
        return "text-text-on-success-strong"
      case "failed":
      case "cancelled":
        return "text-text-on-critical-base"
      default:
        return "text-icon-base"
    }
  }

  const getBlueprintSlotHoldLabel = (slot: BlueprintSlotDisplay) => {
    if (slot.slot.type === "loop" && working()) return i18n._(PI.bpHoldStopRun)
    if (slot.mode === "waiting" || slot.mode === "auditing") return i18n._(PI.bpHoldCancelLoop)
    return i18n._(PI.bpHoldUnequip)
  }

  const getBlueprintSlotAriaLabel = (slot: BlueprintSlotDisplay) => {
    if (slot.slot.type === "loop" && working())
      return i18n._({ ...PI.bpAriaHoldStop, values: { title: slot.slot.title } })
    if (slot.mode === "waiting" || slot.mode === "auditing")
      return i18n._({ ...PI.bpAriaHoldCancel, values: { title: slot.slot.title } })
    return i18n._({ ...PI.bpAriaHoldUnequip, values: { title: slot.slot.title } })
  }

  const getBlueprintFailureTitle = (stopRunningSession: boolean, stoppedSession: boolean) => {
    if (!stopRunningSession) return i18n._(PI.bpFailUnequip)
    if (stoppedSession) return i18n._(PI.bpFailStoppedEquipped)
    return i18n._(PI.bpFailStopRun)
  }

  const abortSession = async (sessionID = params.id) => {
    if (!sessionID) return
    await sdk.client.session.abort({ sessionID })
  }

  const abort = () => {
    abortSession().catch(() => {})
  }

  const clearBoundLoop = (sessionID: string | undefined, loopID: string) => {
    if (!sessionID) return
    sync.set(
      produce((draft) => {
        const session = draft.session.find((item) => item.id === sessionID)
        if (session && session.blueprint?.loopID === loopID) {
          session.blueprint = { ...session.blueprint, loopID: undefined }
        }
      }),
    )
  }

  const clearVisibleSessionLoop = (sessionID: string | undefined, loopID: string) => {
    clearBoundLoop(sessionID, loopID)
    mutateSessionLoop(null)
  }

  const applySessionLoopEvent = (loop: BlueprintLoopInfo) => {
    const activeLoopID = params.id ? info()?.blueprint?.loopID : undefined
    const displayedLoopID = untrack(sessionLoop)?.id
    if (loop.id !== activeLoopID && loop.id !== displayedLoopID) return

    // Terminal: clear whichever reference matched
    if (isTerminalBlueprintLoopStatus(loop.status)) {
      if (loop.id === activeLoopID) clearVisibleSessionLoop(params.id, loop.id)
      else if (loop.id === displayedLoopID) mutateSessionLoop(null)
      return
    }

    // Non-terminal: always update the display. Don't clear first — the
    // session binding (activeLoopID) may arrive after the loop event,
    // and clearing would cause a visible flicker.
    mutateSessionLoop(loop)
  }

  const unsubBlueprintLoopUpdated = sdk.event.on("blueprint_loop.updated", (event) => {
    applySessionLoopEvent(event.properties.loop)
  })
  onCleanup(unsubBlueprintLoopUpdated)

  const [slotLongPress, setSlotLongPress] = createSignal<ReturnType<typeof setTimeout> | null>(null)
  const [slotLongPressProgress, setSlotLongPressProgress] = createSignal(0)
  let slotLongPressFrame: number | undefined

  const startLongPress = (slot: BlueprintSlotDisplay) => {
    if (slotLongPress()) return
    const sessionID = params.id
    const startedAt = performance.now()
    const duration = 2000
    const tick = (now: number) => {
      setSlotLongPressProgress(Math.min(1, (now - startedAt) / duration))
      slotLongPressFrame = requestAnimationFrame(tick)
    }
    setSlotLongPressProgress(0)
    slotLongPressFrame = requestAnimationFrame(tick)
    const t = setTimeout(async () => {
      setSlotLongPress(null)
      if (slotLongPressFrame !== undefined) cancelAnimationFrame(slotLongPressFrame)
      slotLongPressFrame = undefined
      setSlotLongPressProgress(1)
      let stopRunningSession = false
      let stoppedSession = false
      try {
        if (slot.slot.type === "loop") {
          const loopID = slot.slot.loopID
          const isLocalSlot = localArmedLoop() === slot.slot
          const activeLoopID = params.id ? info()?.blueprint?.loopID : undefined
          const loop = sessionLoop()
          if (!isLocalSlot && activeLoopID !== loopID) {
            if (loop?.id === loopID) mutateSessionLoop(null)
            return
          }
          if (!isLocalSlot && isTerminalBlueprintLoopStatus(loop?.status ?? slot.mode)) {
            clearVisibleSessionLoop(sessionID, loopID)
            showToast({
              type: "info",
              title: i18n._(PI.blueprintUnequipped),
              description: slot.slot.title,
            })
            return
          }
          stopRunningSession = working()
          if (stopRunningSession) {
            await abortSession(sessionID)
            stoppedSession = true
          }
          await sdk.client.blueprint.loop.cancel(blueprintLoopRequest(loopID))
          clearVisibleSessionLoop(sessionID, loopID)
        }
        if (localArmedLoop()?.noteID === slot.slot.noteID) setLocalArmedLoop(null)
        showToast({
          type: "info",
          title: stopRunningSession ? i18n._(PI.blueprintRunStopped) : i18n._(PI.blueprintUnequipped),
          description: slot.slot.title,
        })
      } catch (err) {
        showToast({
          type: "error",
          title: getBlueprintFailureTitle(stopRunningSession, stoppedSession),
          description: blueprintRequestErrorMessage(err),
        })
      } finally {
        setSlotLongPressProgress(0)
      }
    }, 2000)
    setSlotLongPress(t)
  }

  const cancelLongPress = () => {
    const t = slotLongPress()
    if (t) {
      clearTimeout(t)
      setSlotLongPress(null)
    }
    if (slotLongPressFrame !== undefined) {
      cancelAnimationFrame(slotLongPressFrame)
      slotLongPressFrame = undefined
    }
    setSlotLongPressProgress(0)
  }
  onCleanup(cancelLongPress)

  const displayedBlueprintLoop = createMemo<BlueprintSlotDisplay | null>(() => {
    return resolveBlueprintSlotDisplay({
      localSlot: localArmedLoop(),
      sessionLoop: sessionLoop(),
      activeLoopID: params.id ? info()?.blueprint?.loopID : undefined,
    })
  })
  const armedWorkflowKind = createMemo<"plan" | "lightloop" | "lattice" | undefined>(() => {
    const workflow = activeWorkflow()?.kind
    if (workflow) return workflow
    if (pendingPlan()) return "plan"
    if (pendingLightLoop()) return "lightloop"
    if (pendingLattice()) return "lattice"
  })

  const promptText = createMemo(() => inlineText(prompt.current()))
  const sessionTransitionPending = createMemo(() => props.sessionTransitionPending === true)
  const submitPending = createMemo(() => newSessionSubmitPending() || sessionTransitionPending())
  const canSubmit = createMemo(() => {
    if (submitPending()) return false
    return canSubmitPrompt({
      text: promptText(),
      working: working(),
      hasBlueprintSlot: !!localArmedLoop(),
    })
  })
  const submitStopsSession = createMemo(() => working() && !promptText().trim())
  const blueprintSubmitActive = createMemo(() => !!displayedBlueprintLoop() && !!localArmedLoop() && !working())

  createEffect(
    on(
      () => sessionKey(),
      () => {
        cancelLongPress()
        setLocalArmedLoop(null)
      },
      { defer: true },
    ),
  )

  const cancelArmedLoop = async () => {
    const slot = localArmedLoop()
    if (!slot) return
    setBlueprintLoading(true)
    try {
      if (slot.type === "loop") await sdk.client.blueprint.loop.cancel(blueprintLoopRequest(slot.loopID))
    } catch {
      // If cancellation fails, still clear the slot locally — the loop is orphaned.
    } finally {
      setBlueprintLoading(false)
      setLocalArmedLoop(null)
      if (slot.type === "loop") mutateSessionLoop(null)
    }
  }
  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const rect = range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - padding) {
      container.scrollTop = bottom - container.clientHeight + padding
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const setPlan = async (next: boolean, title?: string) => {
    if (!params.id) {
      setPendingPlan(next)
      if (next) {
        setPendingLattice(null)
        setPendingLightLoop(false)
      }
      return true
    }
    try {
      await sdk.client.workflow.session.set({
        id: params.id,
        workflowSetInput: { kind: next ? "plan" : "none" },
      })
      return true
    } catch (err) {
      showToast({
        type: "error",
        title: title ?? i18n._(PI.submitFailedTogglePlan),
        description: err instanceof Error ? err.message : i18n._(PI.blueprintUnknownError),
      })
      return false
    }
  }

  const togglePlan = async () => {
    if (blueprintModeLocked() || latticeActive() || lightLoopActive()) return
    await setPlan(!storedPlan())
  }

  const equipPlanBlueprintOffer = async () => {
    const sessionID = params.id
    const offer = sessionID ? untrack(() => sync.data.planBlueprintOffer[sessionID]?.offer) : undefined
    if (!offer || !sessionID) return
    if (working()) {
      showToast({
        type: "warning",
        title: i18n._(PI.sessionRunning),
        description: i18n._(PI.blueprintWaitResponse),
      })
      return
    }
    if (blueprintModeLocked()) {
      showToast({
        type: "warning",
        title: i18n._(PI.blueprintSlotOccupied),
        description: i18n._(PI.blueprintUnequipFirst),
      })
      return
    }

    try {
      await sdk.client.workflow.session.set({
        id: sessionID,
        workflowSetInput: { kind: "none" },
      })
      setLocalArmedLoop({
        type: "pending",
        noteID: offer.noteID,
        title: offer.title,
        runMode: "current",
      })
      sync.planBlueprintOffer.equip(sessionID, offer.key)
      showToast({
        type: "info",
        title: i18n._(PI.blueprintEquipped),
        description: i18n._(PI.blueprintEquippedDesc),
      })
    } catch (err) {
      showToast({
        type: "error",
        title: i18n._(PI.blueprintEquipFailed),
        description: err instanceof Error ? err.message : i18n._(PI.genericRequestFailed),
      })
    }
  }

  // Lattice is active when the current session already has a run, or — on the
  // new-session composer, mirroring Plan — when a config is armed for the
  // first message. The armed config is applied on submit once the session exists.
  const latticeActive = createMemo(() => (params.id ? activeWorkflow()?.kind === "lattice" : !!pendingLattice()))

  const enableLattice = async (config: LatticeEnableConfig) => {
    if (!params.id) {
      // Defer: arm the config; submit applies it after the session is created.
      setPendingLattice({ mode: config.mode, maxModelCalls: config.maxModelCalls })
      setPendingPlan(false)
      setPendingLightLoop(false)
      return
    }
    await sdk.client.workflow.session.set({
      id: params.id,
      workflowSetInput: {
        kind: "lattice",
        mode: config.mode,
        maxModelCalls: config.maxModelCalls,
        goal: config.goal,
        action: config.action,
      },
    })
  }

  const cancelLattice = async () => {
    if (!params.id) {
      setPendingLattice(null)
      return
    }

    try {
      await sdk.client.workflow.session.set({
        id: params.id,
        workflowSetInput: { kind: "none" },
      })
    } catch (err) {
      showToast({
        type: "error",
        title: i18n._(PI.latticeCancelFailed),
        description: err instanceof Error ? err.message : i18n._(PI.genericRequestFailed),
      })
    }
  }

  const openLatticeDialog = (event?: Event) => {
    if (blueprintModeLocked() || planActive() || lightLoopActive()) {
      event?.preventDefault()
      return
    }
    workflowDialog.show(() => <LatticeConfigDialog sdk={sdk as any} sessionID={params.id} onEnable={enableLattice} />)
  }

  const selectLatticeFromMenu = (event?: Event) => {
    const state = resolveLatticeWorkflowMenuState({
      blueprintModeLocked: blueprintModeLocked(),
      latticeActive: latticeActive(),
      planActive: planActive(),
      lightLoopActive: lightLoopActive(),
      working: working(),
    })

    if (state.action === "cancel") {
      void cancelLattice()
      return
    }

    if (state.action === "open") {
      openLatticeDialog(event)
      return
    }

    event?.preventDefault()
  }

  const selectPlanFromMenu = (event?: Event) => {
    if (blueprintModeLocked() || planActive() || latticeActive() || lightLoopActive()) {
      event?.preventDefault()
      return
    }
    void togglePlan()
  }

  const setLightLoop = async (active: boolean) => {
    const activeBackendLightLoop = activeWorkflow()?.kind === "lightloop"
    if (!params.id || !activeBackendLightLoop) {
      setPendingLightLoop(active)
      if (active) {
        setPendingPlan(false)
        setPendingLattice(null)
      }
      return true
    }
    try {
      await sdk.client.workflow.session.cancelLightloop({ id: params.id })
      setPendingLightLoop(false)
      return true
    } catch (err) {
      showToast({
        type: "error",
        title: i18n._(PI.lightLoopToggleFailed),
        description: err instanceof Error ? err.message : i18n._(PI.blueprintUnknownError),
      })
      return false
    }
  }

  const selectLightLoopFromMenu = (event?: Event) => {
    if (blueprintModeLocked() || lightLoopActive() || planActive() || latticeActive()) {
      event?.preventDefault()
      return
    }
    void setLightLoop(true)
  }

  const cancelLightLoop = async () => {
    await setLightLoop(false)
  }

  const safelyCancelLightLoop = async () => {
    if (!params.id) return
    try {
      const cancelled = await setLightLoop(false)
      if (!cancelled) return
      showToast({
        type: "info",
        title: i18n._(PI.lightLoopStopped),
        description: i18n._(PI.lightLoopStoppedDesc),
      })
    } catch {
      return
    }
  }

  const updateLightLoopInstructions = async (instructions: string) => {
    const sessionID = params.id
    if (!sessionID) throw new Error(i18n._(PI.lightLoopSessionUnavailable))
    await sdk.client.workflow.session.updateLightloop({
      id: sessionID,
      lightloopUpdateInput: { instructions },
    })
  }

  const openLightLoopDialog = () => {
    const workflow = activeWorkflow()
    if (!params.id || workflow?.kind !== "lightloop") return
    workflowDialog.show(() => (
      <EditLightLoopDialog
        instructions={workflow.instructions}
        active={persistedLightLoopActive}
        working={working}
        reviewPending={lightLoopReviewPending}
        onSave={updateLightLoopInstructions}
      />
    ))
  }

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })

  const addMenuSections = createMemo<PromptAddMenuSection[]>(() => {
    controller.activeLocale()
    const agentSection: PromptAddMenuSection = {
      id: "agent",
      label: i18n._(PI.toolbarAgent),
      items: local.agent
        .list()
        .filter((a) => !a.hidden)
        .map((agent) => {
          const visual = getAgentVisual(agent)
          const disabled = sessionHasMessages() && !!agent.external
          return {
            id: `agent-${agent.name}`,
            label: translateDescriptor(visual.label, i18n),
            icon: getSemanticIcon("agents.main"),
            selected: local.agent.current()?.name === agent.name,
            disabled,
            tooltip: disabled ? i18n._(PI.externalAgentBlocked) : undefined,
            onSelect: () => {
              if (!disabled) local.agent.set(agent.name)
            },
          }
        }),
    }
    const latticeMenuState = resolveLatticeWorkflowMenuState({
      blueprintModeLocked: blueprintModeLocked(),
      latticeActive: latticeActive(),
      planActive: planActive(),
      lightLoopActive: lightLoopActive(),
      working: working(),
    })

    return [
      {
        id: "context",
        label: i18n._(PI.toolbarContext),
        items: [
          {
            id: "files",
            label: i18n._(PI.toolbarAddFiles),
            description: i18n._(PI.toolbarAttachFiles),
            icon: getSemanticIcon("prompt.attach"),
            onSelect: () => fileInputRef.click(),
          },
        ],
      },
      ...(props.hideAgentSelector || layout.isDesktop() ? [] : [agentSection]),
      {
        id: "workflow",
        label: i18n._(PI.toolbarWorkflow),
        items: [
          {
            id: "light-loop",
            label: i18n._(PI.workflowLightLoop),
            description: lightLoopActive()
              ? (lightLoopInstructions() ?? i18n._(PI.lightLoopNextMsg))
              : i18n._(PI.workflowLightLoopDesc),
            icon: getSemanticIcon("prompt.lightLoop"),
            selected: lightLoopActive(),
            ariaDisabled: blueprintModeLocked() || lightLoopActive() || planActive() || latticeActive(),
            title: blueprintModeLocked()
              ? i18n._(PI.workflowUnavailableBlueprint)
              : lightLoopActive()
                ? i18n._(PI.workflowUnavailableAlready)
                : planActive()
                  ? i18n._(PI.workflowUnavailablePlan)
                  : latticeActive()
                    ? i18n._(PI.workflowUnavailableLattice)
                    : undefined,
            iconClass: lightLoopActive()
              ? "text-icon-base"
              : blueprintModeLocked()
                ? "text-icon-weak-base"
                : "text-icon-base",
            classList: {
              "bg-workbench-selected-bg": lightLoopActive(),
              "text-text-base": lightLoopActive(),
              "opacity-60": blueprintModeLocked() || planActive() || latticeActive(),
            },
            onSelect: selectLightLoopFromMenu,
          },
          {
            id: "plan",
            label: i18n._(PI.workflowPlan),
            description: planActive() ? i18n._(PI.workflowPlanDesc) : i18n._(PI.workflowPlanDescAlt),
            icon: getSemanticIcon("prompt.plan"),
            selected: planActive(),
            ariaDisabled: blueprintModeLocked() || planActive() || latticeActive() || lightLoopActive(),
            title: blueprintModeLocked()
              ? i18n._(PI.workflowPlanUnavailableBp)
              : planActive()
                ? i18n._(PI.workflowPlanUnavailableAlready)
                : lightLoopActive()
                  ? i18n._(PI.workflowPlanUnavailableLl)
                  : latticeActive()
                    ? i18n._(PI.workflowPlanUnavailableLattice)
                    : undefined,
            tooltip: blueprintModeLocked() ? i18n._(PI.workflowPlanUnavailableBp) : undefined,
            iconClass: planActive()
              ? "text-icon-base"
              : blueprintModeLocked()
                ? "text-icon-weak-base"
                : "text-icon-base",
            labelClass: blueprintModeLocked() || latticeActive() || lightLoopActive() ? "text-text-weak" : undefined,
            classList: {
              "bg-workbench-selected-bg": planActive(),
              "text-text-base": planActive(),
              "opacity-60": blueprintModeLocked() || latticeActive() || lightLoopActive(),
            },
            onSelect: selectPlanFromMenu,
          },
          {
            id: "lattice-mode",
            label: i18n._(PI.workflowLattice),
            description: translateDescriptor(latticeMenuState.description, i18n),
            icon: getSemanticIcon("prompt.lattice"),
            selected: latticeActive(),
            ariaDisabled: latticeMenuState.ariaDisabled,
            title: latticeMenuState.title ? translateDescriptor(latticeMenuState.title, i18n) : undefined,
            iconClass: latticeActive()
              ? "text-icon-base"
              : blueprintModeLocked()
                ? "text-icon-weak-base"
                : "text-icon-base",
            classList: {
              "bg-workbench-selected-bg": latticeActive(),
              "text-text-base": latticeActive(),
              "opacity-60": latticeMenuState.ariaDisabled,
            },
            onSelect: selectLatticeFromMenu,
          },
        ],
      },
    ]
  })

  const newSessionStartOptions = createMemo<PromptStartOptionGroup[]>(() => {
    if (params.id) return []

    const workspaceSelection = props.newSessionWorkspaceSelection ?? { mode: "current" as const }
    const worktreeSelected = isWorktreeWorkspaceSelection(workspaceSelection)
    const canCreateWorktree = props.newSessionCanCreateWorktree ?? (!sdk.isHome && !!sdk.directory)
    const mainLabel = isHomeScope(sdk.scopeKey) ? i18n._(PI.wsLabelHome) : i18n._(PI.wsLabelMainCheckout)
    const localDescription = isHomeScope(sdk.scopeKey) ? i18n._(PI.wsDescGlobal) : i18n._(PI.wsDescCurrent)

    return [
      {
        id: "workspace",
        label: i18n._(PI.wsLabelWorkspace),
        options: [
          {
            id: "workspace.local",
            label: mainLabel,
            description: localDescription,
            icon: getSemanticIcon("workspace.main"),
            selected: !worktreeSelected,
            onSelect: () => props.onNewSessionWorkspaceSelectionChange?.({ mode: "current" }),
          },
          {
            id: "workspace.worktree",
            label: i18n._(PI.toolbarWorktree),
            description: i18n._(PI.toolbarWorktreeDesc),
            icon: getSemanticIcon("workspace.worktree"),
            selected: worktreeSelected,
            disabled: !canCreateWorktree,
            tooltip: canCreateWorktree ? i18n._(PI.wsWorktreeTooltipCan) : i18n._(PI.wsWorktreeTooltipCannot),
            onSelect: () =>
              props.onNewSessionWorkspaceSelectionChange?.(
                worktreeOptionSelection({
                  currentDirectory: props.newSessionCurrentDirectory,
                  canonicalDirectory: props.newSessionCanonicalDirectory,
                }),
              ),
          },
        ],
      },
    ]
  })

  createEffect(
    on(
      () => [blueprintModeLocked(), storedPlan()] as const,
      ([locked, active]) => {
        if (!locked || !active) return
        void setPlan(false, i18n._(PI.attachExitPlanFailed))
      },
    ),
  )

  const planBlueprintOfferState = createMemo(() =>
    params.id
      ? (sync.data.planBlueprintOffer[params.id] ?? emptyPlanBlueprintOfferState)
      : emptyPlanBlueprintOfferState,
  )

  const visiblePlanBlueprintOffer = createMemo(() => {
    if (
      !shouldDisplayPlanBlueprintOffer({
        state: planBlueprintOfferState(),
        workflowKind: info()?.workflow?.kind,
        sessionStatus: status(),
        slotOccupied: blueprintModeLocked(),
        currentScopeID: info()?.scope.id,
      })
    ) {
      return null
    }
    return planBlueprintOfferState().offer
  })

  createEffect(() => {
    const offer = visiblePlanBlueprintOffer()
    if (!offer) {
      props.onPriorityControlChange?.(undefined)
      return
    }

    props.onPriorityControlChange?.(
      <PlanBlueprintOfferControl
        offer={offer}
        onEquip={equipPlanBlueprintOffer}
        onDismiss={() => params.id && sync.planBlueprintOffer.dismiss(params.id, offer.key)}
        onMute={() => params.id && sync.planBlueprintOffer.mute(params.id)}
      />,
    )
  })
  onCleanup(() => props.onPriorityControlChange?.(undefined))

  const selectedControlProfile = createMemo<ControlProfileId>(() => {
    const configured = params.id
      ? (info()?.controlProfile ?? sync.data.config.controlProfile)
      : (input.controlProfile() ?? sync.data.config.controlProfile)
    return permissionModeVisual(configured).id
  })
  const activePermissionMode = createMemo(() => permissionModeVisual(selectedControlProfile()))
  const assistantMessages = createMemo(() => {
    if (!params.id) return [] as Message[]
    return (sync.data.message[params.id] ?? []).filter((message) => message.role === "assistant") as Message[]
  })
  const cortexRunning = createMemo(() => {
    const id = params.id
    if (!id) return 0
    return sync.data.cortex.filter((task) => task.parentSessionID === id && task.status === "running").length
  })
  const agentName = createMemo(() => {
    const latestAssistant = assistantMessages().at(-1)
    return titlecaseStatusLabel(latestAssistant?.agent ?? local.agent.current()?.name ?? "Synergy")
  })
  const fallbackWorkingPhrase = createMemo(() =>
    computeWorkingPhrase(
      {
        agentName: agentName(),
        cortexRunning: cortexRunning(),
        seed: params.id ?? sessionKey(),
      },
      i18n,
    ),
  )

  async function updateControlProfile(profile: ControlProfileId, close?: () => void) {
    if (working()) {
      showToast({
        type: "warning",
        title: i18n._(PI.sessionRunning),
        description: i18n._(PI.permissionStopBefore),
      })
      return
    }

    if (!params.id) {
      input.setControlProfile(profile)
      close?.()
      return
    }
    setStore("switchingProfile", true)
    try {
      await sdk.client.session.update({ sessionID: params.id, controlProfile: profile })
      close?.()
    } catch (err) {
      showToast({
        type: "error",
        title: i18n._(PI.permModeUnchanged),
        description: err instanceof Error ? err.message : i18n._(PI.permModeUpdateFailed),
      })
    } finally {
      setStore("switchingProfile", false)
    }
  }
  const uploadedAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "attachment") as UploadedAttachmentPart[],
  )
  const noteAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "note") as NoteAttachmentPart[],
  )
  const sessionAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "session") as SessionAttachmentPart[],
  )
  const hasAttachments = createMemo(
    () => uploadedAttachments().length > 0 || noteAttachments().length > 0 || sessionAttachments().length > 0,
  )

  const [store, setStore] = createStore<PromptInputStore>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    dragging: false,
    mode: "normal",
    applyingHistory: false,
    switchingProfile: false,
  })

  const MAX_HISTORY = 100
  const [history, setHistory] = persisted(
    { ...Persist.global("prompt-history", ["prompt-history.v1"]), migrate: sanitizePromptHistory },
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    { ...Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]), migrate: sanitizePromptHistory },
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )

  const clonePromptParts = (prompt: Prompt): Prompt =>
    sanitizePrompt(prompt).map((part) => {
      if (part.type === "text") return { ...part }
      if (part.type === "attachment") return { ...part }
      if (part.type === "note") return { ...part }
      if (part.type === "session") return { ...part }
      return {
        ...part,
        selection: part.selection ? { ...part.selection } : undefined,
      }
    })

  const promptLength = (prompt: Prompt) => inlineLength(prompt)

  const applyHistoryPrompt = (p: Prompt, position: "start" | "end") => {
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const isFocused = createFocusSignal(() => editorRef)

  createEffect(() => {
    params.id
    editorRef.focus()
    if (params.id) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % PLACEHOLDERS.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  createEffect(() => {
    if (!isFocused()) setStore("popover", null)
  })

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const paths = await files.searchFilesAndDirectories(query)
      return paths.map((path): AtOption => ({ type: "file", path, display: path }))
    },
    key: atKey,
    filterKeys: ["display"],
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      kind: cmd.kind,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    setStore("popover", null)

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      editorRef.innerHTML = ""
      editorRef.textContent = text
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      requestAnimationFrame(() => {
        editorRef.focus()
        const range = document.createRange()
        const sel = window.getSelection()
        range.selectNodeContents(editorRef)
        range.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(range)
      })
      return
    }

    editorRef.innerHTML = ""
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
    refetch: slashRefetch,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title", "description"],
    onSelect: handleSlashSelect,
  })

  createEffect(
    on(
      () => sync.data.command,
      () => slashRefetch(),
      { defer: true },
    ),
  )

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  let composerDocument!: ComposerDocumentController
  const editor = usePromptEditor({
    editor: () => editorRef,
    uploadedAttachments,
    noteAttachments,
    sessionAttachments,
    store,
    setStore,
    atOnInput,
    slashOnInput,
    queueScroll,
    onDocumentChange: () => composerDocument?.changed(),
  })
  const { addPart, handleInput } = editor
  composerDocument = new ComposerDocumentController({
    read: () => ({
      text: editor.documentText(),
      selection: editor.documentSelection(),
      sessionId: params.id,
      mode: store.mode,
    }),
    applyEdits: editor.applyDocumentEdits,
    isEditableRange: editor.isEditableRange,
  })
  const [composerVersion, setComposerVersion] = createSignal(0)
  const unsubscribeComposer = composerDocument.subscribe(() => setComposerVersion((value) => value + 1))
  onCleanup(() => {
    unsubscribeComposer()
    composerDocument.dispose()
  })
  const activeCompletion = () => {
    composerVersion()
    return composerDocument.completion()
  }
  const composerSubmitting = () => {
    composerVersion()
    return composerDocument.submitting()
  }
  const highlightNames = {
    info: "synergy-composer-info",
    warning: "synergy-composer-warning",
    error: "synergy-composer-error",
  }
  createEffect(() => {
    composerVersion()
    const registry = (CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights
    const HighlightConstructor = globalThis.Highlight
    if (!registry || !HighlightConstructor) return
    const decorations = composerDocument.decorations()
    for (const severity of ["info", "warning", "error"] as const) {
      const ranges = decorations
        .filter((item) => item.severity === severity)
        .map((item) => editor.documentRange(item.range))
        .filter((range): range is Range => !!range)
      if (ranges.length > 0) registry.set(highlightNames[severity], new HighlightConstructor(...ranges))
      else registry.delete(highlightNames[severity])
    }
    onCleanup(() => {
      for (const name of Object.values(highlightNames)) registry.delete(name)
    })
  })

  createEffect(
    on(
      sessionKey,
      () => {
        composerDocument.abortSubmit(new DOMException("Composer navigation changed", "AbortError"))
        composerDocument.changed()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => store.mode,
      () => composerDocument.changed(),
      { defer: true },
    ),
  )

  onMount(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection?.anchorNode || !editorRef.contains(selection.anchorNode)) return
      composerDocument.selectionChanged()
    }
    document.addEventListener("selectionchange", onSelectionChange)
    onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange))
  })

  const { addAttachments, removeAttachment, handlePaste, handleDragOver, handleDragLeave, handleDrop } =
    usePromptAttachments({
      editor: () => editorRef,
      isFocused,
      addPart,
      noteAttachments,
      sessionAttachments,
      localArmedLoop,
      activeLoopID: () => info()?.blueprint?.loopID,
      working,
      workflowKind: armedWorkflowKind,
      clearPendingWorkflows: () => {
        setPendingPlan(false)
        setPendingLightLoop(false)
      },
      setLocalArmedLoop,
      setStore,
    })

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const text = inlineText(prompt).trim()
    const hasAttachment = prompt.some(
      (part) => part.type === "attachment" || part.type === "note" || part.type === "session",
    )
    if (!text && !hasAttachment) return

    const entry = clonePromptParts(prompt)
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const lastEntry = currentHistory.entries[0]
    if (lastEntry && isPromptEqual(lastEntry, entry)) return

    setCurrentHistory("entries", (entries) => [entry, ...entries].slice(0, MAX_HISTORY))
  }

  const navigateHistory = (direction: "up" | "down") => {
    const entries = store.mode === "shell" ? shellHistory.entries : history.entries
    const current = store.historyIndex

    if (direction === "up") {
      if (entries.length === 0) return false
      if (current === -1) {
        setStore("savedPrompt", clonePromptParts(prompt.current()))
        setStore("historyIndex", 0)
        applyHistoryPrompt(entries[0], "start")
        return true
      }
      if (current < entries.length - 1) {
        const next = current + 1
        setStore("historyIndex", next)
        applyHistoryPrompt(entries[next], "start")
        return true
      }
      return false
    }

    if (current > 0) {
      const next = current - 1
      setStore("historyIndex", next)
      applyHistoryPrompt(entries[next], "end")
      return true
    }
    if (current === 0) {
      setStore("historyIndex", -1)
      const saved = store.savedPrompt
      if (saved) {
        applyHistoryPrompt(saved, "end")
        setStore("savedPrompt", null)
        return true
      }
      applyHistoryPrompt(DEFAULT_PROMPT, "end")
      return true
    }

    return false
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && composerSubmitting()) {
      composerDocument.abortSubmit(new DOMException("Composer submit cancelled", "AbortError"))
      event.preventDefault()
      return
    }
    if (composerSubmitting()) return
    const completion = activeCompletion()
    if (event.key === "Tab" && completion && !store.popover) {
      event.preventDefault()
      void composerDocument.applyEdits({
        revision: completion.revision,
        edits: [{ range: { start: completion.position, end: completion.position }, text: completion.text }],
      })
      return
    }
    if (event.key === "Escape" && completion) {
      composerDocument.selectionChanged()
      event.preventDefault()
      return
    }
    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }
    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Escape") {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    if (
      store.popover &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter" || event.key === "Tab")
    ) {
      if (store.popover === "at") {
        atOnKeyDown(event)
      } else {
        slashOnKeyDown(event)
      }
      event.preventDefault()
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        setStore("popover", null)
        event.preventDefault()
        return
      }
      if (working()) {
        abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textLength = promptLength(prompt.current())
      const textContent = inlineText(prompt.current())
      const isEmpty = textContent.trim() === "" || textLength <= 1
      const hasNewlines = textContent.includes("\n")
      const inHistory = store.historyIndex >= 0
      const atStart = cursorPosition <= (isEmpty ? 1 : 0)
      const atEnd = cursorPosition >= (isEmpty ? textLength - 1 : textLength)
      const allowUp = isEmpty || atStart || (!hasNewlines && !inHistory) || (inHistory && atEnd)
      const allowDown = isEmpty || atEnd || (!hasNewlines && !inHistory) || (inHistory && atStart)

      if (event.key === "ArrowUp") {
        if (!allowUp) return
        if (navigateHistory("up")) {
          event.preventDefault()
        }
        return
      }

      if (!allowDown) return
      if (navigateHistory("down")) {
        event.preventDefault()
      }
      return
    }

    const modEnter = event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    const plainEnter = event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (sendShortcut() === "enter") {
      if (plainEnter) {
        handleSubmit(event)
        return
      }
      if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        addPart({ type: "text", content: "\n", start: 0, end: 0 })
        event.preventDefault()
        return
      }
    } else {
      if (modEnter) {
        handleSubmit(event)
        return
      }
      if (plainEnter) {
        addPart({ type: "text", content: "\n", start: 0, end: 0 })
        event.preventDefault()
        return
      }
    }
    if (event.key === "Escape") {
      if (store.popover) {
        setStore("popover", null)
      } else if (working()) {
        abort()
      }
    }
  }

  const handleSubmit = usePromptSubmit({
    props,
    uploadedAttachments,
    noteAttachments,
    sessionAttachments,
    selectedControlProfile,
    pendingPlan,
    clearPendingPlan: () => setPendingPlan(false),
    pendingLattice,
    clearPendingLattice: () => setPendingLattice(null),
    pendingLightLoop,
    clearPendingLightLoop: () => {
      setPendingLightLoop(false)
    },
    localArmedLoop,
    setLocalArmedLoop,
    setBlueprintLoading,
    newSessionSubmitPending,
    setNewSessionSubmitPending,
    store,
    setStore,
    addToHistory,
    frontendCommands: () => command.options,
    working,
    abort,
    editor: () => editorRef,
    queueScroll,
    onWorktreeUnavailable: () => workflowDialog.show(() => <WorktreeUnavailableDialog />),
    beforeSubmit: () => composerDocument!.beforeSubmit(),
  })

  createEffect(() => {
    if (params.id || !prompt.ready()) return
    const recovery = sessionTransition.getRecovery(sdk.scopeKey)
    if (!recovery) return
    sessionTransition.clearRecovery(sdk.scopeKey)
    const autoSubmit = restoreNewSessionRecovery({
      recovery,
      setDraft: (draft) => {
        prompt.set(draft.prompt, inlineLength(draft.prompt))
        prompt.context.set(draft.context)
      },
      setMode: (mode) => setStore("mode", mode),
      setWorkspaceSelection: (selection) => props.onNewSessionWorkspaceSelectionChange?.(selection),
      setControlProfile: input.setControlProfile,
      setPlan: setPendingPlan,
      setLattice: setPendingLattice,
      setLightLoop: setPendingLightLoop,
      setBlueprintSlot: setLocalArmedLoop,
      setAgent: local.agent.set,
      setModel: (model) => local.model.set(model),
      setVariant: (variant, model) => local.model.variant.set(variant, model),
    })
    if (!autoSubmit) {
      requestAnimationFrame(() => editorRef?.focus())
      return
    }
    requestAnimationFrame(() => void handleSubmit(new Event("submit", { cancelable: true })))
  })

  const runRuntimeCommand = (name: string) => {
    const sessionID = params.id
    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!sessionID || !currentModel || !currentAgent) return

    sendSessionCommand({
      client: sdk.client,
      sessionID,
      command: name,
      agent: currentAgent.name,
      model: { modelID: currentModel.id, providerID: currentModel.provider.id },
      variant: local.model.variant.current(),
    }).catch((err) => {
      showToast({
        type: "error",
        title: i18n._(PI.commandSendFailed),
        description: err instanceof Error ? err.message : i18n._(PI.genericRequestFailed),
      })
    })
  }

  return (
    <div class="relative z-0 size-full _max-h-[320px] flex flex-col gap-3 overflow-visible">
      <Show when={params.id}>
        <div class="absolute -top-3 right-5 z-20 hidden md:flex items-center gap-1.5">
          <SessionAgendaWakeIndicator sessionID={params.id!} />
          <QuickActions
            class="relative"
            onCommand={(id) => command.trigger(id)}
            onRuntimeCommand={runRuntimeCommand}
            commandsDisabled={working()}
            commands={command.options}
          />
        </div>
      </Show>
      <Show when={params.id}>
        <LatticePanel sdk={sdk as any} sessionID={params.id!} />
      </Show>
      <Show when={store.popover}>
        <PromptPopover
          mode={() => store.popover}
          setSlashRef={(el) => (slashPopoverRef = el)}
          atItems={atFlat}
          atActive={atActive}
          atKey={atKey}
          onAtSelect={handleAtSelect}
          slashItems={slashFlat}
          slashActive={slashActive}
          onSlashSelect={handleSlashSelect}
          keybindFor={(id) => command.keybind(id)}
        />
      </Show>
      <ComposerSlotOutlet slot="composer.above" sessionId={params.id} class="flex min-w-0 flex-col gap-2" />
      <ComposerExtensionOutlet controller={composerDocument} sessionId={params.id} />
      <form
        onSubmit={handleSubmit}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => {
          if (composerSubmitting()) {
            event.preventDefault()
            return
          }
          void handleDrop(event)
        }}
        classList={{
          "prompt-input-shell bg-surface-raised-stronger-non-alpha relative": true,
          "prompt-input-shell-dragging": store.dragging,
          "overflow-hidden": true,
          "border border-border-base": !store.dragging,
          "border border-icon-info-active border-dashed": store.dragging,
          "max-md:border-t max-md:border-x-0 max-md:border-b-0 max-md:shadow-none": true,
          [props.class ?? ""]: !!props.class,
        }}
        style={{ "z-index": 1 }}
      >
        <Show when={store.dragging}>
          <div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-raised-stronger-non-alpha/90 pointer-events-none">
            <div class="flex flex-col items-center gap-2 text-text-weak">
              <Icon name={getSemanticIcon("prompt.attach")} class="size-8" />
              <span class="text-14-regular">{i18n._(PI.dropZone)}</span>
            </div>
          </div>
        </Show>
        <Show when={prompt.context.items().length > 0}>
          <div class="flex flex-wrap items-center gap-2 px-3 pt-3">
            <For each={prompt.context.items()}>
              {(item) => (
                <div class="flex items-center gap-2 px-2 py-1 rounded-md bg-surface-base border border-border-base max-w-full">
                  <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-12-regular min-w-0">
                    <span class="text-text-weak whitespace-nowrap truncate min-w-0">{getDirectory(item.path)}</span>
                    <span class="text-text-strong whitespace-nowrap">{getFilename(item.path)}</span>
                    <Show when={item.selection}>
                      {(sel) => (
                        <span class="text-text-weak whitespace-nowrap ml-1">
                          {sel().startLine === sel().endLine
                            ? `:${sel().startLine}`
                            : `:${sel().startLine}-${sel().endLine}`}
                        </span>
                      )}
                    </Show>
                  </div>
                  <IconButton
                    type="button"
                    icon={getSemanticIcon("action.close")}
                    variant="ghost"
                    class="h-6 w-6"
                    onClick={() => prompt.context.remove(item.key)}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={hasAttachments()}>
          <PromptAttachments
            uploads={uploadedAttachments}
            notes={noteAttachments}
            sessions={sessionAttachments}
            serverUrl={sdk.url}
            removeAttachment={removeAttachment}
          />
        </Show>
        <div class="relative max-h-[240px] overflow-y-auto" ref={(el) => (scrollRef = el)}>
          <div
            data-component="prompt-input"
            ref={(el) => {
              editorRef = el
              props.ref?.(el)
            }}
            contenteditable="true"
            onBeforeInput={(event) => {
              if (composerSubmitting() && !editor.isApplyingDocumentEdits()) event.preventDefault()
            }}
            onInput={handleInput}
            onPaste={(event) => {
              if (composerSubmitting()) {
                event.preventDefault()
                return
              }
              void handlePaste(event)
            }}
            onCompositionStart={() => {
              setComposing(true)
              composerDocument.setComposing(true)
            }}
            onCompositionEnd={() => {
              setComposing(false)
              composerDocument.setComposing(false)
            }}
            onKeyDown={handleKeyDown}
            classList={{
              "select-text": true,
              "w-full px-5 py-3 pr-12 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "font-mono!": store.mode === "shell",
            }}
          />
          <Show when={activeCompletion()}>
            {(completion) => (
              <div class="absolute top-0 inset-x-0 px-5 py-3 pr-12 text-14-regular pointer-events-none whitespace-pre-wrap text-text-subtle">
                <span class="invisible">{editor.completionPrefix()}</span>
                <span>{completion().text}</span>
              </div>
            )}
          </Show>
          <Show when={!prompt.dirty()}>
            <div class="absolute top-0 inset-x-0 px-5 py-3 pr-12 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate">
              {store.mode === "shell"
                ? i18n._(PI.placeholderShell)
                : planActive()
                  ? i18n._(PI.placeholderPlan)
                  : isHomeScope(sdk.scopeKey)
                    ? `Ask me anything... "${PLACEHOLDERS_GLOBAL[store.placeholder % PLACEHOLDERS_GLOBAL.length]}"`
                    : `Ask anything... "${PLACEHOLDERS[store.placeholder]}"`}
            </div>
          </Show>
        </div>
        <div class="prompt-input-toolbar flex flex-wrap items-center justify-between gap-2">
          <div class="prompt-input-toolbar-main min-w-0 flex flex-wrap items-center gap-1">
            <ComposerSlotOutlet slot="composer.toolbar.left" sessionId={params.id} class="contents" />
            <Switch>
              <Match when={store.mode === "shell"}>
                <div class="prompt-input-toolbar-chip flex items-center gap-2">
                  <Icon name={getSemanticIcon("prompt.shell")} size="small" class="text-icon-interactive-base" />
                  <span class="text-12-medium text-text-interactive-base">{i18n._(PI.shellLabel)}</span>
                  <span class="text-11-regular text-text-subtle">{i18n._(PI.shellEscToExit)}</span>
                </div>
              </Match>
              <Match when={store.mode === "normal"}>
                <Show when={!props.hideAgentSelector}>
                  <div class="hidden md:block">
                    <ToolbarSelectorPopover
                      trigger={
                        <button type="button" class="prompt-input-toolbar-button flex items-center gap-1.5">
                          <span class="text-12-medium text-text-base whitespace-nowrap">
                            {translateDescriptor(getAgentVisual(local.agent.current()).label, i18n)}
                          </span>
                          <Icon
                            name={getSemanticIcon("navigation.collapse")}
                            size="small"
                            class="text-icon-weak-base shrink-0"
                          />
                        </button>
                      }
                      title={i18n._(PI.selectAgent)}
                      contentClass="w-52 max-h-80"
                      placement="top-start"
                    >
                      {(close) => (
                        <List
                          class="p-1"
                          items={local.agent.list().filter((a) => !a.hidden)}
                          key={(x) => x.name}
                          filterKeys={["name"]}
                          onSelect={(x) => {
                            if (!x) return
                            if (sessionHasMessages() && x.external) return
                            local.agent.set(x.name)
                            close()
                          }}
                        >
                          {(agent) => {
                            const visual = getAgentVisual(agent)
                            return (
                              <Tooltip
                                placement="right"
                                value={
                                  sessionHasMessages() && agent.external ? i18n._(PI.externalAgentBlocked) : undefined
                                }
                              >
                                <div
                                  classList={{
                                    "flex items-center justify-between gap-3 px-2 py-1.5": true,
                                    "opacity-45": sessionHasMessages() && !!agent.external,
                                  }}
                                >
                                  <div class="min-w-0">
                                    <div class="text-13-medium text-text-base truncate">
                                      {translateDescriptor(visual.label, i18n)}
                                    </div>
                                  </div>
                                </div>
                              </Tooltip>
                            )
                          }}
                        </List>
                      )}
                    </ToolbarSelectorPopover>
                  </div>
                </Show>
                <PermissionModeSelector
                  working={working}
                  switching={() => store.switchingProfile}
                  activeMode={activePermissionMode}
                  selectedProfile={selectedControlProfile}
                  updateProfile={updateControlProfile}
                />
                <Show when={planActive()}>
                  <WorkflowChip
                    label={i18n._(PI.exitPlanLabel)}
                    ariaLabel={i18n._(PI.exitPlan)}
                    tooltip={i18n._(PI.exitPlan)}
                    icon={getSemanticIcon("prompt.plan")}
                    working={working}
                    onCancel={togglePlan}
                  />
                </Show>
                <Show when={lightLoopActive()}>
                  <WorkflowChip
                    label={i18n._(PI.cancelLightLoopLabel)}
                    ariaLabel={i18n._(PI.cancelLightLoop)}
                    tooltip={i18n._(PI.cancelLightLoop)}
                    icon={getSemanticIcon("prompt.lightLoop")}
                    working={working}
                    onCancel={cancelLightLoop}
                  />
                </Show>
                <Show when={latticeActive()}>
                  <WorkflowChip
                    label={i18n._(PI.cancelLatticeLabel)}
                    ariaLabel={i18n._(PI.cancelLattice)}
                    tooltip={i18n._(PI.cancelLattice)}
                    icon={getSemanticIcon("prompt.lattice")}
                    working={working}
                    onCancel={cancelLattice}
                  />
                </Show>
                <ComposerSlotOutlet slot="composer.add-menu" sessionId={params.id} class="contents" />
                <PromptAddMenu sections={addMenuSections()} />
                <ComposerSlotOutlet slot="composer.start-option" sessionId={params.id} class="contents" />
                <PromptStartModeSelector groups={newSessionStartOptions()} />
              </Match>
            </Switch>
          </div>
          <div class="prompt-input-toolbar-actions ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              class="hidden"
              onChange={(e) => {
                const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : []
                e.currentTarget.value = ""
                if (files.length > 0) void addAttachments(files)
              }}
            />
            <ComposerSlotOutlet slot="composer.toolbar.right" sessionId={params.id} class="contents" />
            <Show when={!sdk.connected()}>
              <Tooltip placement="top" value={i18n._(PI.connectionLost)}>
                <div class="flex items-center justify-center size-5">
                  <Icon
                    name={getSemanticIcon("prompt.signal")}
                    size="small"
                    class="text-icon-warning-base animate-pulse"
                  />
                </div>
              </Tooltip>
            </Show>
            <Switch>
              <Match when={blueprintSubmitActive() && displayedBlueprintLoop()}>
                {(bp) => (
                  <div class="flex h-9 max-w-full items-center rounded-lg border border-border-interactive-base/35 bg-surface-interactive-selected-weak/70 p-0.5 shadow-xs">
                    <Tooltip
                      placement="top"
                      value={
                        <div class="min-w-56 max-w-72">
                          <div class="text-12-medium text-text-strong truncate">{bp().slot.title}</div>
                          <div class="mt-1 text-10-regular text-text-weak">{i18n._(PI.bpReady)}</div>
                          <div class="mt-2 text-10-regular text-text-weak">{getBlueprintSlotHoldLabel(bp())}</div>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        class="group relative flex h-8 min-w-0 max-w-36 items-center gap-1.5 overflow-hidden rounded-md px-2.5 text-text-interactive-base transition-colors hover:bg-surface-raised-base-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong-base/35 select-none"
                        aria-label={getBlueprintSlotAriaLabel(bp())}
                        onPointerDown={() => startLongPress(bp())}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                      >
                        <span class="relative flex size-4 shrink-0 items-center justify-center">
                          <span class="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity group-hover:opacity-0">
                            <Icon
                              name={getSemanticIcon("blueprint.main")}
                              class={getBlueprintSlotIconClass(bp().mode)}
                              size="small"
                            />
                          </span>
                          <span class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                            <Icon
                              name={getSemanticIcon("action.close")}
                              class="text-text-interactive-base"
                              size="small"
                            />
                          </span>
                        </span>
                        <span class="max-w-24 truncate text-11-medium">{i18n._(PI.loopReady)}</span>
                        <span
                          class="absolute bottom-0 left-2 h-0.5 rounded-full bg-text-interactive-base/80 transition-[width] duration-75"
                          style={{ width: `${slotLongPressProgress() * 82}%` }}
                        />
                      </button>
                    </Tooltip>
                    <Tooltip
                      placement="top"
                      value={
                        <div class="flex items-center gap-2">
                          <span>{i18n._(PI.startBpLoop)}</span>
                          <Icon name={getSemanticIcon("prompt.submit")} size="small" class="text-icon-base" />
                        </div>
                      }
                    >
                      <IconButton
                        type="submit"
                        aria-label={i18n._(PI.startBpLoop)}
                        icon={getSemanticIcon("prompt.blueprintStart")}
                        variant="primary"
                        class="prompt-input-submit size-8 rounded-full! bg-text-interactive-base!"
                      />
                    </Tooltip>
                  </div>
                )}
              </Match>
              <Match when={true}>
                <Show when={displayedBlueprintLoop()}>
                  {(bp) => (
                    <Tooltip
                      placement="top"
                      value={
                        <div class="min-w-48 max-w-64">
                          <div class="text-12-medium text-text-strong truncate">{bp().slot.title}</div>
                          <div class="mt-1 text-10-regular text-text-weak">
                            {getBlueprintSlotStatusLabel(bp().mode)}
                          </div>
                          <div class="mt-2 text-10-regular text-text-weak">{getBlueprintSlotHoldLabel(bp())}</div>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        class="prompt-input-toolbar-icon-button bp-slot group relative flex items-center justify-center size-8 overflow-hidden cursor-default select-none"
                        aria-label={getBlueprintSlotAriaLabel(bp())}
                        onPointerDown={() => startLongPress(bp())}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                      >
                        <span class="relative flex size-4 shrink-0 items-center justify-center">
                          <span class="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity group-hover:opacity-0">
                            <Icon
                              name={getSemanticIcon("blueprint.main")}
                              class={getBlueprintSlotIconClass(bp().mode)}
                              size="small"
                            />
                          </span>
                          <span class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                            <Icon name={getSemanticIcon("action.close")} class="text-icon-base" size="small" />
                          </span>
                        </span>
                        <span
                          class="absolute bottom-1 left-1 h-0.5 rounded-full bg-text-interactive-base/80 transition-[width] duration-75"
                          style={{ width: `${slotLongPressProgress() * 75}%` }}
                        />
                      </button>
                    </Tooltip>
                  )}
                </Show>
                <Show when={lightLoopInstructions()}>
                  {(instructions) => (
                    <LightLoopSubmitControl
                      instructions={instructions()}
                      onEdit={openLightLoopDialog}
                      onCancel={safelyCancelLightLoop}
                    />
                  )}
                </Show>
                <Tooltip
                  placement="top"
                  inactive={!submitPending() && !canSubmit()}
                  value={
                    <Show
                      when={!submitPending()}
                      fallback={
                        <span>
                          {sessionTransitionPending()
                            ? i18n._(PI.submitTransitionPendingTitle)
                            : i18n._(PI.startingSession)}
                        </span>
                      }
                    >
                      <Switch>
                        <Match when={submitStopsSession()}>
                          <div class="flex items-center gap-2">
                            <span>{i18n._(PI.stopAction)}</span>
                            <span class="text-icon-base text-12-medium text-[10px]!">{i18n._(PI.escKey)}</span>
                          </div>
                        </Match>
                        <Match when={true}>
                          <div class="flex items-center gap-2">
                            <span>{i18n._(PI.sendAction)}</span>
                            <Icon name={getSemanticIcon("prompt.submit")} size="small" class="text-icon-base" />
                          </div>
                        </Match>
                      </Switch>
                    </Show>
                  }
                >
                  <IconButton
                    type="submit"
                    aria-label={submitStopsSession() ? i18n._(PI.stopSession) : i18n._(PI.sendMessage)}
                    disabled={!canSubmit()}
                    icon={submitStopsSession() ? getSemanticIcon("action.stop") : getSemanticIcon("prompt.submitArrow")}
                    variant="primary"
                    class="prompt-input-submit size-9 rounded-full!"
                  />
                </Tooltip>
              </Match>
            </Switch>
          </div>
        </div>
      </form>
      <ComposerSlotOutlet slot="composer.below" sessionId={params.id} class="flex min-w-0 flex-col gap-2" />
    </div>
  )
}
