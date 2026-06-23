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
  ContentPart,
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
import { ContextBar } from "@/components/context-bar"
import { QuickActions } from "@/components/quick-actions"
import { isGlobalScope } from "@/utils/scope"
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
import { usePromptSubmit } from "@/components/prompt-input/submit"
import { usePromptAttachments } from "@/components/prompt-input/attachments-hook"
import { inlineLength, inlineText, isInlinePart } from "@/components/prompt-input/content"
import {
  createFilePill,
  createTextFragment,
  getCursorPosition,
  getNodeLength,
  setCursorPosition,
} from "@/components/prompt-input/editor-dom"

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
  const planMode = createMemo(() => info()?.blueprint?.planMode ?? false)

  const [sessionLoop] = createResource(
    () => (params.id ? info()?.blueprint?.loopID : null),
    async (loopID) => {
      if (!loopID) return null
      try {
        const result = await sdk.client.blueprint.loop.get({ id: loopID })
        return (result.data as BlueprintLoopInfo) ?? null
      } catch {
        return null
      }
    },
  )

  const getBlueprintSlotIcon = (status: string) => {
    switch (status) {
      case "armed":
        return "crosshair"
      case "running":
        return "play"
      case "auditing":
        return "search"
      case "completed":
        return "check"
      case "failed":
        return "x"
      case "cancelled":
        return "ban"
      default:
        return "target"
    }
  }

  const [slotHover, setSlotHover] = createSignal(false)
  const [slotLongPress, setSlotLongPress] = createSignal<ReturnType<typeof setTimeout> | null>(null)

  const startLongPress = () => {
    if (slotLongPress()) return
    const bp = displayedBlueprintLoop()
    if (
      !bp ||
      (bp.mode !== "armed" &&
        bp.mode !== "completed" &&
        bp.mode !== "failed" &&
        bp.mode !== "cancelled" &&
        bp.mode !== "running" &&
        bp.mode !== "waiting")
    )
      return
    const t = setTimeout(async () => {
      setSlotLongPress(null)
      const armed = localArmedLoop()
      if (armed) {
        await sdk.client.blueprint.loop.cancel({ id: armed.loopID }).catch(() => {})
        setLocalArmedLoop(null)
        showToast({ type: "info", title: "Blueprint unequipped", description: armed.title })
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
  }

  const displayedBlueprintLoop = createMemo(() => {
    const localArmed = localArmedLoop()
    if (localArmed) return { loop: localArmed, mode: "armed" as const }
    const loop = sessionLoop()
    if (loop) return { loop, mode: loop.status }
    return null
  })

  const cancelArmedLoop = async () => {
    const slot = localArmedLoop()
    if (!slot) return
    setBlueprintLoading(true)
    try {
      await sdk.client.blueprint.loop.cancel({ id: slot.loopID })
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

  const togglePlanMode = async () => {
    if (!params.id) return
    const current = planMode()
    try {
      await sdk.client.blueprint.session.planMode({
        id: params.id,
        planMode: !current,
      })
    } catch (err) {
      showToast({
        type: "error",
        title: "Failed to toggle Plan Mode",
        description: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }

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

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        const nextIsBr = next?.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === "BR"
        if (!prevIsBr && !nextIsBr) return false
        if (nextIsBr && !prevIsBr && prev) return false
        return true
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    editorRef.innerHTML = ""
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file") {
        editorRef.appendChild(createFilePill(part))
      }
    }
  }

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

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const inputParts = currentParts.filter(isInlinePart) as Prompt
        const domParts = parseFromDOM()
        if (isNormalizedEditor() && isPromptEqual(inputParts, domParts)) return

        const selection = window.getSelection()
        let cursorPosition: number | null = null
        if (selection && selection.rangeCount > 0 && editorRef.contains(selection.anchorNode)) {
          cursorPosition = getCursorPosition(editorRef)
        }

        renderEditor(inputParts)

        if (cursorPosition !== null) {
          setCursorPosition(editorRef, cursorPosition)
        }
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      const content = buffer.replace(/\r\n?/g, "\n").replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const attachments = uploadedAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText = inlineText(rawParts)
    const trimmed = rawText.replace(/\u200B/g, "").trim()
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset =
      trimmed.length === 0 &&
      !hasNonText &&
      images.length === 0 &&
      attachments.length === 0 &&
      noteAttachments().length === 0 &&
      sessionAttachments().length === 0

    if (shouldReset) {
      setStore("popover", null)
      if (store.historyIndex >= 0 && !store.applyingHistory) {
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
      }
      if (prompt.dirty()) {
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        setStore("popover", null)
      }
    } else {
      setStore("popover", null)
    }

    if (store.historyIndex >= 0 && !store.applyingHistory) {
      setStore("historyIndex", -1)
      setStore("savedPrompt", null)
    }

    prompt.set([...rawParts, ...images, ...attachments, ...noteAttachments(), ...sessionAttachments()], cursorPosition)
    queueScroll()
  }

  const setRangeEdge = (range: Range, edge: "start" | "end", offset: number) => {
    let remaining = offset
    const nodes = Array.from(editorRef.childNodes)

    for (const node of nodes) {
      const length = getNodeLength(node)
      const isText = node.nodeType === Node.TEXT_NODE
      const isPill = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.type === "file"
      const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

      if (isText && remaining <= length) {
        if (edge === "start") range.setStart(node, remaining)
        if (edge === "end") range.setEnd(node, remaining)
        return
      }

      if ((isPill || isBreak) && remaining <= length) {
        if (edge === "start" && remaining === 0) range.setStartBefore(node)
        if (edge === "start" && remaining > 0) range.setStartAfter(node)
        if (edge === "end" && remaining === 0) range.setEndBefore(node)
        if (edge === "end" && remaining > 0) range.setEndAfter(node)
        return
      }

      remaining -= length
    }
  }

  const addPart = (part: ContentPart) => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const cursorPosition = getCursorPosition(editorRef)
    const currentPrompt = prompt.current()
    const rawText = inlineText(currentPrompt)
    const textBeforeCursor = rawText.substring(0, cursorPosition)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)

    if (part.type === "file") {
      const pill = createFilePill(part)
      const gap = document.createTextNode(" ")
      const range = selection.getRangeAt(0)

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(range, "start", start)
        setRangeEdge(range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (part.type === "text") {
      const range = selection.getRangeAt(0)
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(last)
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    setStore("popover", null)
  }

  const { addAttachment, removeAttachment, handlePaste, handleDragOver, handleDragLeave, handleDrop } =
    usePromptAttachments({
      editor: () => editorRef,
      isFocused,
      addPart,
      noteAttachments,
      sessionAttachments,
      localArmedLoop,
      setLocalArmedLoop,
      setBlueprintLoading,
      setStore,
    })

  const abort = () => {
    const sessionID = params.id!
    sdk.client.session.abort({ sessionID }).catch(() => {})
  }

  const sendQuickAction = (text: string) => {
    const sessionID = params.id
    if (!sessionID || working()) return

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) return

    const agent = currentAgent.name
    const model = { modelID: currentModel.id, providerID: currentModel.provider.id }
    const variant = local.model.variant.current()
    const messageID = Identifier.ascending("message")
    const textPart = { id: Identifier.ascending("part"), type: "text" as const, text }

    const optimistic: Message = { id: messageID, sessionID, role: "user", time: { created: Date.now() }, agent, model }
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

    sdk.client.session.promptAsync({ sessionID, agent, model, messageID, parts: [textPart], variant }).catch(() => {
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
            disabled={working()}
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
          "bg-surface-raised-stronger-non-alpha relative": true,
          "overflow-hidden": true,
          "focus-within:ring-1 focus-within:ring-border-weak-base": true,
          "border border-border-base": !store.dragging,
          "border border-icon-info-active border-dashed": store.dragging,
          "max-md:border-t max-md:border-x-0 max-md:border-b-0 max-md:shadow-none": true,
          [props.class ?? ""]: !!props.class,
        }}
        style={{ "border-radius": layout.isDesktop() ? "24px" : "0px", "z-index": 1 }}
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
                  : isGlobalScope(sdk.directory)
                    ? `Ask me anything... "${PLACEHOLDERS_GLOBAL[store.placeholder % PLACEHOLDERS_GLOBAL.length]}"`
                    : `Ask anything... "${PLACEHOLDERS[store.placeholder]}"`}
            </div>
          </Show>
        </div>
        <div class="px-4 py-2.5 flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5">
            <Switch>
              <Match when={store.mode === "shell"}>
                <div class="flex items-center gap-2 px-3 h-7 rounded-full bg-surface-base">
                  <Icon name="terminal" size="small" class="text-icon-primary" />
                  <span class="text-12-medium text-text-primary">Shell</span>
                  <span class="text-11-regular text-text-subtle">esc to exit</span>
                </div>
              </Match>
              <Match when={store.mode === "normal"}>
                <Show when={!props.hideAgentSelector}>
                  <ToolbarSelectorPopover
                    trigger={
                      <button
                        type="button"
                        class="flex items-center gap-1.5 h-7 px-3 rounded-full border border-border-weak-base bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
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
                <Tooltip placement="top" value="Attach file">
                  <button
                    type="button"
                    class="flex items-center justify-center size-7 rounded-full border border-border-weak-base bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
                    onClick={() => fileInputRef.click()}
                  >
                    <Icon name="paperclip" size="small" class="text-icon-base" />
                  </button>
                </Tooltip>
                <Show when={params.id}>
                  <ContextBar />
                </Show>
                <PermissionModeSelector
                  working={working}
                  switching={() => store.switchingProfile}
                  activeMode={activePermissionMode}
                  selectedProfile={selectedControlProfile}
                  updateProfile={updateControlProfile}
                />
              </Match>
            </Switch>
          </div>
          <div class="flex items-center gap-2">
            <Show when={displayedBlueprintLoop()}>
              {(bp) => (
                <div class="bp-slot flex items-center h-8 rounded-full border border-border-weak-base bg-surface-base px-3 gap-2 hover:bg-surface-raised-base-hover cursor-default">
                  <Icon name={getBlueprintSlotIcon(bp().mode)} class="text-icon-interactive-base" size="small" />
                  <span class="text-12-medium text-text-base truncate max-w-[120px]">{bp().loop.title}</span>
                  <span class="text-10-medium text-text-weak">{bp().mode}</span>
                </div>
              )}
            </Show>
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
            <Tooltip
              placement="top"
              inactive={!prompt.dirty() && !working()}
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
              <Tooltip
                placement="top"
                inactive={!prompt.dirty() && !working() && !localArmedLoop()}
                value={localArmedLoop() ? "Start BlueprintLoop" : working() && !prompt.dirty() ? "Stop" : "Send"}
              >
                <IconButton
                  type="submit"
                  disabled={!prompt.dirty() && !working() && !localArmedLoop()}
                  icon={localArmedLoop() ? "zap" : working() && !prompt.dirty() ? "square" : "arrow-up"}
                  variant="primary"
                  class={localArmedLoop() ? "size-9 rounded-full! bg-text-interactive-base!" : "size-9 rounded-full!"}
                />
              </Tooltip>
            </Tooltip>
          </div>
        </div>
      </form>
    </div>
  )
}
