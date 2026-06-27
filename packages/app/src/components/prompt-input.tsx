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
  usePrompt,
  ImageAttachmentPart,
  UploadedAttachmentPart,
  NoteAttachmentPart,
  SessionAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { Identifier } from "@/utils/id"
import { List } from "@ericsanchezok/synergy-ui/list"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getAgentVisual } from "@/components/agent-visual"
import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { QuickActions } from "@/components/quick-actions"
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
import { inlineLength, inlineText } from "@/components/prompt-input/content"
import { getCursorPosition, setCursorPosition } from "@/components/prompt-input/editor-dom"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const sync = useSync()
  const input = useInput()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const params = useParams()
  const command = useCommand()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const [localArmedLoop, setLocalArmedLoop] = createSignal<BlueprintSlot | null>(null)
  const [blueprintLoading, setBlueprintLoading] = createSignal(false)
  const idle = { type: "idle" as const }
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey()))
  const sendShortcut = createMemo(() => input.sendShortcut())
  const activeFile = createMemo(() => {
    const tab = tabs().active()
    if (!tab) return
    return files.pathFromTab(tab)
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const status = createMemo(() => sync.data.session_status[params.id ?? ""] ?? idle)
  const working = createMemo(() => status()?.type !== "idle")
  const [pendingPlanMode, setPendingPlanMode] = createSignal(false)
  const storedPlanMode = createMemo(() => (params.id ? (info()?.blueprint?.planMode ?? false) : pendingPlanMode()))
  const blueprintModeLocked = createMemo(() => !!localArmedLoop() || !!info()?.blueprint?.loopID)
  const planMode = createMemo(() => !blueprintModeLocked() && storedPlanMode())
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
        if (id) setPendingPlanMode(false)
      },
    ),
  )

  const sessionLoopSource = createMemo(() => {
    const loopID = params.id ? info()?.blueprint?.loopID : undefined
    if (!loopID) return null
    return { loopID, directory: sessionScopeDirectory() }
  })

  const [sessionLoop] = createResource(sessionLoopSource, async ({ loopID, directory }) => {
    if (!loopID) return null
    try {
      const result = await sdk.client.blueprint.loop.get(blueprintLoopRequest(loopID, directory))
      return (result.data as BlueprintLoopInfo) ?? null
    } catch {
      return null
    }
  })

  type BlueprintSlotDisplay = {
    slot: BlueprintSlot
    mode: string
  }

  const getBlueprintSlotStatusLabel = (status: string) => {
    switch (status) {
      case "pending":
        return "Ready to start"
      case "armed":
        return "Equipped"
      case "running":
        return "Running"
      case "waiting":
        return "Waiting"
      case "auditing":
        return "In review"
      case "completed":
        return "Completed"
      case "failed":
        return "Needs attention"
      case "cancelled":
        return "Unequipped"
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
        return "text-green-600"
      case "auditing":
        return "text-amber-600"
      case "completed":
        return "text-green-700"
      case "failed":
      case "cancelled":
        return "text-red-600"
      default:
        return "text-icon-base"
    }
  }

  function requestErrorMessage(err: unknown) {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return "Request failed"
  }

  const getBlueprintSlotHoldLabel = (slot: BlueprintSlotDisplay) => {
    if (slot.slot.type === "loop" && working()) return "Hold for 2 seconds to stop this Blueprint run."
    if (slot.mode === "waiting" || slot.mode === "auditing") return "Hold for 2 seconds to cancel this BlueprintLoop."
    return "Hold for 2 seconds to unequip."
  }

  const getBlueprintSlotAriaLabel = (slot: BlueprintSlotDisplay) => {
    if (slot.slot.type === "loop" && working()) return `Hold to stop Blueprint run: ${slot.slot.title}`
    if (slot.mode === "waiting" || slot.mode === "auditing") return `Hold to cancel BlueprintLoop: ${slot.slot.title}`
    return `Hold to unequip Blueprint: ${slot.slot.title}`
  }

  const getBlueprintFailureTitle = (stopRunningSession: boolean, stoppedSession: boolean) => {
    if (!stopRunningSession) return "Failed to unequip Blueprint"
    if (stoppedSession) return "Session stopped, Blueprint still equipped"
    return "Failed to stop Blueprint run"
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
      const stopRunningSession = slot.slot.type === "loop" && working()
      let stoppedSession = false
      try {
        if (stopRunningSession) {
          await abortSession(sessionID)
          stoppedSession = true
        }
        if (slot.slot.type === "loop") {
          const loopID = slot.slot.loopID
          await sdk.client.blueprint.loop.cancel(blueprintLoopRequest(loopID))
          clearBoundLoop(sessionID, loopID)
        }
        if (localArmedLoop()?.noteID === slot.slot.noteID) setLocalArmedLoop(null)
        showToast({
          type: "info",
          title: stopRunningSession ? "Blueprint run stopped" : "Blueprint unequipped",
          description: slot.slot.title,
        })
      } catch (err) {
        showToast({
          type: "error",
          title: getBlueprintFailureTitle(stopRunningSession, stoppedSession),
          description: requestErrorMessage(err),
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
    const localSlot = localArmedLoop()
    if (localSlot) return { slot: localSlot, mode: localSlot.type === "pending" ? "pending" : "armed" }
    const loop = sessionLoop()
    if (loop)
      return {
        slot: {
          type: "loop" as const,
          loopID: loop.id,
          noteID: loop.noteID,
          title: loop.title,
          runMode: loop.runMode ?? "current",
        },
        mode: loop.status,
      }
    return null
  })

  const canSubmit = createMemo(() => prompt.dirty() || working() || !!localArmedLoop())
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

  const setPlanMode = async (next: boolean, title = "Failed to toggle Plan Mode") => {
    if (!params.id) {
      setPendingPlanMode(next)
      return true
    }
    try {
      await sdk.client.blueprint.session.planMode({
        id: params.id,
        planMode: next,
      })
      return true
    } catch (err) {
      showToast({
        type: "error",
        title,
        description: err instanceof Error ? err.message : "Unknown error",
      })
      return false
    }
  }

  const togglePlanMode = async () => {
    if (blueprintModeLocked()) return
    await setPlanMode(!storedPlanMode())
  }

  const selectPlanModeFromMenu = (event?: Event) => {
    if (blueprintModeLocked()) {
      event?.preventDefault()
      return
    }
    if (planMode()) return
    void togglePlanMode()
  }

  const addMenuSections = createMemo<PromptAddMenuSection[]>(() => [
    {
      id: "context",
      items: [
        {
          id: "files",
          label: "Add files",
          icon: "paperclip",
          onSelect: () => fileInputRef.click(),
        },
        {
          id: "plan-mode",
          label: "Plan mode",
          icon: planMode() ? "check" : "list-checks",
          disabled: planMode(),
          ariaDisabled: blueprintModeLocked(),
          title: blueprintModeLocked()
            ? "Plan Mode is unavailable while a Blueprint is equipped"
            : planMode()
              ? "Plan Mode is already enabled"
              : undefined,
          tooltip: blueprintModeLocked() ? "Plan Mode is unavailable while a Blueprint is equipped" : undefined,
          iconClass: planMode() || blueprintModeLocked() ? "text-icon-weak" : "text-icon-base",
          labelClass: blueprintModeLocked() ? "text-text-weak" : undefined,
          classList: {
            "opacity-60": blueprintModeLocked(),
          },
          onSelect: selectPlanModeFromMenu,
        },
      ],
    },
  ])

  const newSessionStartOptions = createMemo<PromptStartOptionGroup[]>(() => {
    if (params.id) return []

    const creatingWorktree = props.newSessionWorktree === "create"
    const canCreateWorktree = props.newSessionCanCreateWorktree ?? (!sdk.isHome && !!sdk.directory)
    const localLabel = isHomeScope(sdk.scopeKey) ? "Home" : "Local"
    const localDescription = isHomeScope(sdk.scopeKey) ? "Global context" : "Current checkout"

    return [
      {
        id: "workspace",
        label: "Workspace",
        options: [
          {
            id: "workspace.local",
            label: localLabel,
            description: localDescription,
            icon: getSemanticIcon("workspace.main"),
            selected: !creatingWorktree,
            onSelect: () => props.onNewSessionWorktreeChange?.("main"),
          },
          {
            id: "workspace.worktree",
            label: "Worktree",
            description: "Isolated checkout",
            icon: getSemanticIcon("workspace.worktree"),
            selected: creatingWorktree,
            disabled: !canCreateWorktree,
            tooltip: canCreateWorktree
              ? "Create an isolated worktree for this session."
              : "Choose a project to use worktree isolation.",
            onSelect: () => props.onNewSessionWorktreeChange?.("create"),
          },
        ],
      },
    ]
  })

  createEffect(
    on(
      () => [blueprintModeLocked(), storedPlanMode()] as const,
      ([locked, active]) => {
        if (!locked || !active) return
        void setPlanMode(false, "Failed to exit Plan Mode")
      },
    ),
  )

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
  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
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
    computeWorkingPhrase({
      agentName: agentName(),
      cortexRunning: cortexRunning(),
      seed: params.id ?? sessionKey(),
    }),
  )

  async function updateControlProfile(profile: ControlProfileId, close?: () => void) {
    if (working()) {
      showToast({
        type: "warning",
        title: "Session is running",
        description: "Stop the session before changing its permission mode.",
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
        title: "Permission mode unchanged",
        description: err instanceof Error ? err.message : "Failed to update the session permission mode.",
      })
    } finally {
      setStore("switchingProfile", false)
    }
  }
  const imageAttachments = createMemo(
    () => prompt.current().filter((part) => part.type === "image") as ImageAttachmentPart[],
  )
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
    () =>
      imageAttachments().length > 0 ||
      uploadedAttachments().length > 0 ||
      noteAttachments().length > 0 ||
      sessionAttachments().length > 0,
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
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )

  const clonePromptParts = (prompt: Prompt): Prompt =>
    prompt.map((part) => {
      if (part.type === "text") return { ...part }
      if (part.type === "image") return { ...part }
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

  const { addPart, handleInput } = usePromptEditor({
    editor: () => editorRef,
    imageAttachments,
    uploadedAttachments,
    noteAttachments,
    sessionAttachments,
    store,
    setStore,
    atOnInput,
    slashOnInput,
    queueScroll,
  })

  const { addAttachment, removeAttachment, handlePaste, handleDragOver, handleDragLeave, handleDrop } =
    usePromptAttachments({
      editor: () => editorRef,
      isFocused,
      addPart,
      noteAttachments,
      sessionAttachments,
      localArmedLoop,
      activeLoopID: () => info()?.blueprint?.loopID,
      setLocalArmedLoop,
      setStore,
    })

  const sendQuickAction = (text: string) => {
    const sessionID = params.id
    if (!sessionID) return

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) return

    const agent = currentAgent.name
    const model = { modelID: currentModel.id, providerID: currentModel.provider.id }
    const variant = local.model.variant.current()
    const messageID = Identifier.ascending("message")
    const textPart = { id: Identifier.ascending("part"), type: "text" as const, text }

    const optimistic: Message = { id: messageID, sessionID, role: "user", time: { created: Date.now() }, agent, model }
    let optimisticAdded = false
    const addOptimisticMessage = () => {
      sync.set(
        produce((draft) => {
          const messages = draft.message[sessionID]
          if (!messages) {
            draft.message[sessionID] = [optimistic]
          } else {
            const { index } = Binary.search(messages, messageID, (m) => m.id)
            messages.splice(index, 0, optimistic)
          }
          draft.part[messageID] = [{ ...textPart, sessionID, messageID }] as unknown as Part[]
        }),
      )
      optimisticAdded = true
    }
    const removeOptimisticMessage = () => {
      sync.set(
        produce((draft) => {
          const messages = draft.message[sessionID]
          if (messages) {
            const { index, found } = Binary.search(messages, messageID, (m) => m.id)
            if (found) messages.splice(index, 1)
          }
          delete draft.part[messageID]
        }),
      )
      optimisticAdded = false
    }

    if (!working()) addOptimisticMessage()

    sdk.client.session
      .input({ sessionID, agent, model, messageID, parts: [textPart], variant })
      .then((result) => {
        if (result.data?.status === "queued" && optimisticAdded) removeOptimisticMessage()
      })
      .catch(() => {
        if (optimisticAdded) removeOptimisticMessage()
      })
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const text = inlineText(prompt).trim()
    const hasAttachment = prompt.some(
      (part) => part.type === "image" || part.type === "attachment" || part.type === "note" || part.type === "session",
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

    if (store.popover && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter")) {
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
    imageAttachments,
    uploadedAttachments,
    noteAttachments,
    sessionAttachments,
    activeFile,
    selectedControlProfile,
    planMode,
    localArmedLoop,
    setLocalArmedLoop,
    setBlueprintLoading,
    store,
    setStore,
    addToHistory,
    working,
    abort,
    editor: () => editorRef,
    queueScroll,
  })

  return (
    <div class="relative z-0 size-full _max-h-[320px] flex flex-col gap-3 overflow-visible">
      <Show when={params.id}>
        <div class="absolute -top-3 right-5 z-20 flex items-center gap-1.5">
          <SessionAgendaWakeIndicator sessionID={params.id!} />
          <QuickActions
            class="relative"
            onSend={sendQuickAction}
            onCommand={(id) => command.trigger(id)}
            commandsDisabled={working()}
          />
        </div>
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
      <form
        onSubmit={handleSubmit}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
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
              <Icon name="paperclip" class="size-8" />
              <span class="text-14-regular">Drop files, notes, or sessions here</span>
            </div>
          </div>
        </Show>
        <Show when={false && (prompt.context.items().length > 0 || !!activeFile())}>
          <div class="flex flex-wrap items-center gap-2 px-3 pt-3">
            <Show when={prompt.context.activeTab() ? activeFile() : undefined}>
              {(path) => (
                <div class="flex items-center gap-2 px-2 py-1 rounded-md bg-surface-base border border-border-base max-w-full">
                  <FileIcon node={{ path: path(), type: "file" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-12-regular min-w-0">
                    <span class="text-text-weak whitespace-nowrap truncate min-w-0">{getDirectory(path())}</span>
                    <span class="text-text-strong whitespace-nowrap">{getFilename(path())}</span>
                    <span class="text-text-weak whitespace-nowrap ml-1">active</span>
                  </div>
                  <IconButton
                    type="button"
                    icon="x"
                    variant="ghost"
                    class="h-6 w-6"
                    onClick={() => prompt.context.removeActive()}
                  />
                </div>
              )}
            </Show>
            <Show when={!prompt.context.activeTab() && !!activeFile()}>
              <button
                type="button"
                class="flex items-center gap-2 px-2 py-1 rounded-md bg-surface-base border border-border-base text-12-regular text-text-weak hover:bg-surface-raised-base-hover"
                onClick={() => prompt.context.addActive()}
              >
                <Icon name="plus" size="small" />
                <span>Include active file</span>
              </button>
            </Show>
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
                    icon="x"
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
            images={imageAttachments}
            uploads={uploadedAttachments}
            notes={noteAttachments}
            sessions={sessionAttachments}
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
            onInput={handleInput}
            onPaste={handlePaste}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={handleKeyDown}
            classList={{
              "select-text": true,
              "w-full px-5 py-3 pr-12 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "font-mono!": store.mode === "shell",
            }}
          />
          <Show when={!prompt.dirty()}>
            <div class="absolute top-0 inset-x-0 px-5 py-3 pr-12 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate">
              {store.mode === "shell"
                ? "Enter shell command..."
                : planMode()
                  ? "Plan your approach..."
                  : isHomeScope(sdk.scopeKey)
                    ? `Ask me anything... "${PLACEHOLDERS_GLOBAL[store.placeholder % PLACEHOLDERS_GLOBAL.length]}"`
                    : `Ask anything... "${PLACEHOLDERS[store.placeholder]}"`}
            </div>
          </Show>
        </div>
        <div class="prompt-input-toolbar flex flex-wrap items-center justify-between gap-2">
          <div class="prompt-input-toolbar-main min-w-0 flex flex-wrap items-center gap-1">
            <Switch>
              <Match when={store.mode === "shell"}>
                <div class="prompt-input-toolbar-chip flex items-center gap-2">
                  <Icon name="terminal" size="small" class="text-icon-interactive-base" />
                  <span class="text-12-medium text-text-interactive-base">Shell</span>
                  <span class="text-11-regular text-text-subtle">esc to exit</span>
                </div>
              </Match>
              <Match when={store.mode === "normal"}>
                <Show when={!props.hideAgentSelector}>
                  <ToolbarSelectorPopover
                    trigger={
                      <button
                        type="button"
                        class="prompt-input-toolbar-button flex items-center gap-1.5"
                      >
                        <span class="text-12-medium text-text-base whitespace-nowrap">
                          {getAgentVisual(local.agent.current()).label}
                        </span>
                        <Icon name="chevron-down" size="small" class="text-icon-weak shrink-0" />
                      </button>
                    }
                    title="Select agent"
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
                                sessionHasMessages() && agent.external
                                  ? "Create a new session to use this external agent"
                                  : undefined
                              }
                            >
                              <div
                                classList={{
                                  "flex items-center justify-between gap-3 px-2 py-1.5": true,
                                  "opacity-45": sessionHasMessages() && !!agent.external,
                                }}
                              >
                                <div class="min-w-0">
                                  <div class="text-13-medium text-text-base truncate">{visual.label}</div>
                                </div>
                              </div>
                            </Tooltip>
                          )
                        }}
                      </List>
                    )}
                  </ToolbarSelectorPopover>
                </Show>
                <PermissionModeSelector
                  working={working}
                  switching={() => store.switchingProfile}
                  activeMode={activePermissionMode}
                  selectedProfile={selectedControlProfile}
                  updateProfile={updateControlProfile}
                />
                <Show when={planMode()}>
                  <Tooltip placement="top" value="Exit Plan Mode">
                    <button
                      type="button"
                      aria-label="Exit Plan Mode"
                      class="prompt-input-toolbar-button prompt-input-compact-control group flex items-center gap-1.5 text-text-weak hover:text-text-base"
                      onClick={() => void togglePlanMode()}
                    >
                      <span class="relative flex size-4 shrink-0 items-center justify-center">
                        <span class="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity group-hover:opacity-0">
                          <Icon name="list-checks" size="small" class="text-icon-weak" />
                        </span>
                        <span class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                          <Icon name="x" size="small" class="text-icon-base" />
                        </span>
                      </span>
                      <span class="prompt-input-compact-label text-12-medium leading-none">Plan</span>
                    </button>
                  </Tooltip>
                </Show>
                <PromptAddMenu sections={addMenuSections()} />
                <PromptStartModeSelector groups={newSessionStartOptions()} />
              </Match>
            </Switch>
          </div>
          <div class="prompt-input-toolbar-actions ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept={FILE_INPUT_ACCEPT}
              class="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                if (file) addAttachment(file)
                e.currentTarget.value = ""
              }}
            />
            <Show when={!sdk.connected()}>
              <Tooltip placement="top" value="Connection lost — responses may be delayed">
                <div class="flex items-center justify-center size-5">
                  <Icon name="signal" size="small" class="text-icon-warning-base animate-pulse" />
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
                          <div class="mt-1 text-10-regular text-text-weak">Ready to start this BlueprintLoop.</div>
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
                              name={getSemanticIcon("orchestration.blueprint")}
                              class={getBlueprintSlotIconClass(bp().mode)}
                              size="small"
                            />
                          </span>
                          <span class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                            <Icon name="x" class="text-text-interactive-base" size="small" />
                          </span>
                        </span>
                        <span class="max-w-24 truncate text-11-medium">Loop ready</span>
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
                          <span>Start BlueprintLoop</span>
                          <Icon name="corner-down-left" size="small" class="text-icon-base" />
                        </div>
                      }
                    >
                      <IconButton
                        type="submit"
                        icon="zap"
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
                            Blueprint {getBlueprintSlotStatusLabel(bp().mode).toLowerCase()}
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
                              name={getSemanticIcon("orchestration.blueprint")}
                              class={getBlueprintSlotIconClass(bp().mode)}
                              size="small"
                            />
                          </span>
                          <span class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                            <Icon name="x" class="text-icon-base" size="small" />
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
                <Tooltip
                  placement="top"
                  inactive={!canSubmit()}
                  value={
                    <Switch>
                      <Match when={working() && !prompt.dirty()}>
                        <div class="flex items-center gap-2">
                          <span>Stop</span>
                          <span class="text-icon-base text-12-medium text-[10px]!">ESC</span>
                        </div>
                      </Match>
                      <Match when={true}>
                        <div class="flex items-center gap-2">
                          <span>Send</span>
                          <Icon name="corner-down-left" size="small" class="text-icon-base" />
                        </div>
                      </Match>
                    </Switch>
                  }
                >
                  <IconButton
                    type="submit"
                    disabled={!canSubmit()}
                    icon={working() && !prompt.dirty() ? "square" : "arrow-up"}
                    variant="primary"
                    class="prompt-input-submit size-9 rounded-full!"
                  />
                </Tooltip>
              </Match>
            </Switch>
          </div>
        </div>
      </form>
    </div>
  )
}
