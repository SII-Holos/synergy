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
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useLocal } from "@/context/local"
import { useInput } from "@/context/input"
import { useFile, type FileSelection } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  TextPart,
  ImageAttachmentPart,
  UploadedAttachmentPart,
  NoteAttachmentPart,
  SessionAttachmentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { FileIcon } from "@ericsanchezok/synergy-ui/file-icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { List } from "@ericsanchezok/synergy-ui/list"
import { ToolbarSelectorPopover, ToolbarSelectorTrigger } from "@/components/toolbar-selector"
import { getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { ModelSelectorPopover, DialogSelectModelUnpaid } from "@/components/dialog"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { Identifier } from "@/utils/id"
import { usePermission } from "@/context/permission"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { createSynergyClient, type Message, type Part } from "@ericsanchezok/synergy-sdk/client"
import { Binary } from "@ericsanchezok/synergy-util/binary"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { ContextBar } from "@/components/context-bar"
import { QuickActions } from "@/components/quick-actions"
import { isGlobalScope } from "@/utils/scope"
import {
  isTextAttachmentFile,
  preparePromptAttachment,
  PromptAttachmentError,
  uploadPromptAttachment,
} from "@/utils/prompt-attachment"
import { PromptStatusBurst, type PromptStatusBurstItem } from "@/components/session/prompt-status-burst"
import {
  createStatusBurstGate,
  computePromptRawStatus,
  computePromptWorkingSummary,
} from "@/components/session/session-status-shared"
import { computeWorkingPhrase, titlecaseStatusLabel } from "@ericsanchezok/synergy-ui/session-status"

type InlinePart = TextPart | FileAttachmentPart

function isInlinePart(part: ContentPart): part is InlinePart {
  return part.type === "text" || part.type === "file"
}

function inlineText(parts: Prompt): string {
  return parts
    .filter(isInlinePart)
    .map((p) => p.content)
    .join("")
}

function inlineLength(parts: Prompt): number {
  return parts.filter(isInlinePart).reduce((len, p) => len + p.content.length, 0)
}

function createPromptPartID(): string {
  return Identifier.ascending("part")
}

const NOTE_PREVIEW_MAX_LINES = 2000
const SESSION_PREVIEW_MAX_MESSAGES = 24
const SESSION_PREVIEW_MAX_TEXT_LENGTH = 12000

type DroppedSessionData = {
  id: string
  directory: string
  title?: string
  updatedAt?: number
}

function formatSessionReference(attachment: SessionAttachmentPart): string {
  return `<session-ref id="${attachment.sessionId}" directory="${attachment.directory}" title="${attachment.title || "Untitled"}" />`
}

function formatNoteContent(attachment: NoteAttachmentPart): string {
  const lines = attachment.content.split("\n")
  const truncated = lines.length > NOTE_PREVIEW_MAX_LINES
  const visible = truncated ? lines.slice(0, NOTE_PREVIEW_MAX_LINES).join("\n") : attachment.content
  const title = attachment.title || "Untitled"

  let result = `<note id="${attachment.noteId}" title="${title}">\n\n${visible}`

  if (truncated) {
    result += `\n\n[Truncated at line ${NOTE_PREVIEW_MAX_LINES} of ${lines.length} total — use note_read(id="${attachment.noteId}", offset=${NOTE_PREVIEW_MAX_LINES}) to view remaining content]`
  }

  result += "\n\n</note>"
  return result
}

function formatSessionPreview(input: {
  attachment: SessionAttachmentPart
  sessionMessages: Message[]
  getParts: (messageID: string) => Part[]
}): string {
  const { attachment, sessionMessages, getParts } = input
  const title = attachment.title || "Untitled"
  const messages = sessionMessages.slice(-SESSION_PREVIEW_MAX_MESSAGES)
  const previewBlocks: string[] = []
  let totalLength = 0
  let truncated = sessionMessages.length > messages.length

  for (const message of messages) {
    const parts = getParts(message.id)
    const text = parts
      .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
    if (!text) continue

    const role = message.role === "assistant" ? "assistant" : "user"
    const block = `<message role="${role}" id="${message.id}">\n${text}\n</message>`
    if (totalLength + block.length > SESSION_PREVIEW_MAX_TEXT_LENGTH) {
      truncated = true
      break
    }
    previewBlocks.push(block)
    totalLength += block.length
  }

  let result = `<session-ref id="${attachment.sessionId}" directory="${attachment.directory}" title="${title}">\n`
  if (previewBlocks.length > 0) {
    result += `\n${previewBlocks.join("\n\n")}\n`
  } else {
    result += "\n[No text messages available in cached preview]\n"
  }
  if (truncated) {
    result += `\n[Truncated preview — open session ${attachment.sessionId} for fuller context]\n`
  }
  result += "\n</session-ref>"
  return result
}

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const ACCEPTED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]
const ACCEPTED_TEXT_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".log",
  ".lua",
  ".m",
  ".md",
  ".mjs",
  ".patch",
  ".php",
  ".pl",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svg",
  ".svelte",
  ".swift",
  ".tex",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]
const ACCEPTED_TEXT_MIME_PATTERNS = [
  "text/*",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_DOCUMENT_TYPES]
const FILE_INPUT_ACCEPT = [...ACCEPTED_FILE_TYPES, ...ACCEPTED_TEXT_MIME_PATTERNS, ...ACCEPTED_TEXT_EXTENSIONS].join(
  ",",
)

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
}

const PLACEHOLDERS = [
  "Fix a TODO in the codebase",
  "What is the tech stack of this project?",
  "Fix broken tests",
  "Explain how authentication works",
  "Find and fix security vulnerabilities",
  "Add unit tests for the user service",
  "Refactor this function to be more readable",
  "What does this error mean?",
  "Help me debug this issue",
  "Generate API documentation",
  "Optimize database queries",
  "Add input validation",
  "Create a new component for...",
  "How do I deploy this project?",
  "Review my code for best practices",
  "Add error handling to this function",
  "Explain this regex pattern",
  "Convert this to TypeScript",
  "Add logging throughout the codebase",
  "What dependencies are outdated?",
  "Help me write a migration script",
  "Implement caching for this endpoint",
  "Add pagination to this list",
  "Create a CLI command for...",
  "How do environment variables work here?",
]

const PLACEHOLDERS_GLOBAL = [
  "What's on your mind?",
  "Help me write an email",
  "Summarize this article for me",
  "Brainstorm ideas for...",
  "Explain quantum computing simply",
  "Plan a trip to Tokyo",
  "Help me prepare for an interview",
  "Draft a blog post about...",
  "Compare pros and cons of...",
  "Translate this to French",
]

interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const input = useInput()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const params = useParams()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

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
  const assistantMessages = createMemo(() => {
    if (!params.id) return [] as Message[]
    return (sync.data.message[params.id] ?? []).filter((message) => message.role === "assistant") as Message[]
  })
  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })
  const isCurrentAgentExternal = createMemo(() => !!local.agent.current()?.external)
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
  const promptRawStatus = createMemo(() =>
    computePromptRawStatus({
      assistantMessages: assistantMessages(),
      getParts: (messageID: string) => sync.data.part[messageID] ?? [],
    }),
  )
  const promptWorkingSummary = createMemo(() =>
    computePromptWorkingSummary({
      status: status(),
      working: working(),
      rawStatus: promptRawStatus(),
      fallbackWorkingPhrase: fallbackWorkingPhrase(),
    }),
  )
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

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: Prompt | null
    placeholder: number
    dragging: boolean
    mode: "normal" | "shell"
    applyingHistory: boolean
    promptBursts: PromptStatusBurstItem[]
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    dragging: false,
    mode: "normal",
    applyingHistory: false,
    promptBursts: [],
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

  const addAttachment = async (file: File) => {
    if (!ACCEPTED_FILE_TYPES.includes(file.type) && !isTextAttachmentFile(file)) return

    try {
      const cursorPosition = prompt.cursor() ?? getCursorPosition(editorRef)
      if (isTextAttachmentFile(file)) {
        const uploaded = await uploadPromptAttachment(sdk.url, file)
        const attachment: UploadedAttachmentPart = {
          type: "attachment",
          id: createPromptPartID(),
          filename: file.name,
          mime: uploaded.mime,
          url: uploaded.url,
        }
        prompt.set([...prompt.current(), attachment], cursorPosition)
        return
      }

      const prepared = await preparePromptAttachment(file)
      if (prepared.mime.startsWith("image/")) {
        const attachment: ImageAttachmentPart = {
          type: "image",
          id: createPromptPartID(),
          filename: file.name,
          mime: prepared.mime,
          dataUrl: prepared.dataUrl,
        }
        prompt.set([...prompt.current(), attachment], cursorPosition)
        return
      }

      const attachment: UploadedAttachmentPart = {
        type: "attachment",
        id: createPromptPartID(),
        filename: file.name,
        mime: prepared.mime,
        url: prepared.dataUrl,
      }
      prompt.set([...prompt.current(), attachment], cursorPosition)
    } catch (error) {
      const description =
        error instanceof PromptAttachmentError
          ? error.message
          : error instanceof Error
            ? error.message
            : "This attachment couldn’t be prepared. Try another file."

      showToast({
        title: error instanceof PromptAttachmentError ? error.title : "Couldn’t attach file",
        description,
      })
    }
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => !("id" in part) || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    if (!isFocused()) return
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const items = Array.from(clipboardData.items)
    const imageItems = items.filter((item) => ACCEPTED_FILE_TYPES.includes(item.type))

    if (imageItems.length > 0) {
      for (const item of imageItems) {
        const file = item.getAsFile()
        if (file) await addAttachment(file)
      }
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""
    addPart({ type: "text", content: plainText, start: 0, end: 0 })
  }

  const DROPPABLE_TYPES = ["Files", "application/x-synergy-note", "application/x-synergy-session"]

  const handleDragOver = (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    const hasDroppable = event.dataTransfer?.types.some((t) => DROPPABLE_TYPES.includes(t))
    if (hasDroppable) {
      setStore("dragging", true)
    }
  }

  const handleDragLeave = (event: DragEvent) => {
    if (dialog.active) return

    const currentTarget = event.currentTarget
    const relatedTarget = event.relatedTarget
    if (
      currentTarget instanceof HTMLElement &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return
    }

    setStore("dragging", false)
  }

  const handleDrop = async (event: DragEvent) => {
    if (dialog.active) return

    event.preventDefault()
    setStore("dragging", false)

    const sessionData = event.dataTransfer?.getData("application/x-synergy-session")
    if (sessionData) {
      try {
        const dropped = JSON.parse(sessionData) as DroppedSessionData
        if (!dropped.id || !dropped.directory) return
        if (dropped.id === params.id && dropped.directory === sdk.directory) return
        const existing = sessionAttachments().find(
          (attachment) => attachment.sessionId === dropped.id && attachment.directory === dropped.directory,
        )
        if (existing) return
        const attachment: SessionAttachmentPart = {
          type: "session",
          id: createPromptPartID(),
          sessionId: dropped.id,
          directory: dropped.directory,
          title: dropped.title || "Untitled",
          updatedAt: dropped.updatedAt,
        }
        const cursorPosition = prompt.cursor() ?? getCursorPosition(editorRef)
        prompt.set([...prompt.current(), attachment], cursorPosition)
      } catch {}
      return
    }

    const noteData = event.dataTransfer?.getData("application/x-synergy-note")
    if (noteData) {
      try {
        const { id: noteId, title, content } = JSON.parse(noteData)
        const existing = noteAttachments().find((n) => n.noteId === noteId)
        if (existing) return
        const attachment: NoteAttachmentPart = {
          type: "note",
          id: createPromptPartID(),
          noteId,
          title: title || "Untitled",
          content: content || "",
        }
        const cursorPosition = prompt.cursor() ?? getCursorPosition(editorRef)
        prompt.set([...prompt.current(), attachment], cursorPosition)
      } catch {}
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    for (const file of Array.from(dropped)) {
      if (ACCEPTED_FILE_TYPES.includes(file.type) || isTextAttachmentFile(file)) {
        await addAttachment(file)
      }
    }
  }

  const statusBurstGate = createStatusBurstGate(2500)
  createEffect(() => {
    const summary = promptWorkingSummary()
    statusBurstGate.next(summary, (text) => {
      const id = createPromptPartID()
      const durationMs = 2600 + Math.round(Math.random() * 700)
      const delayMs = Math.round(Math.random() * 180)
      const startY = 18 + Math.round(Math.random() * 8)
      const vx = Math.round(Math.random() * 16 - 8)
      const vy = -(78 + Math.round(Math.random() * 16))
      const ax = Math.round(Math.random() * 10 - 5)
      const ay = -(14 + Math.round(Math.random() * 8))
      const startScale = 0.92 + Math.random() * 0.03
      const peakScale = 0.99 + Math.random() * 0.03
      const endScale = 0.95 + Math.random() * 0.03
      setStore("promptBursts", (items) => [
        ...items.slice(-1),
        { id, text, startY, vx, vy, ax, ay, startScale, peakScale, endScale, delayMs, durationMs },
      ])
      window.setTimeout(
        () => {
          setStore("promptBursts", (items) => items.filter((item) => item.id !== id))
        },
        durationMs + delayMs + 160,
      )
    })
  })

  createEffect(() => {
    if (!working()) {
      statusBurstGate.reset()
      setStore("promptBursts", [])
    }
  })

  createEffect(() => {
    if (!isFocused()) setStore("popover", null)
  })

  type AtOption = { type: "file"; path: string; display: string }

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

  const createPill = (part: FileAttachmentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", "file")
    pill.setAttribute("data-path", part.path)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

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
        editorRef.appendChild(createPill(part))
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
      const pill = createPill(part)
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

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part && part.type === "text" ? part.content : "")).join("")
    const images = imageAttachments().slice()
    const attachments = uploadedAttachments().slice()
    const notes = noteAttachments().slice()
    const sessions = sessionAttachments().slice()
    const mode = store.mode

    if (
      text.trim().length === 0 &&
      images.length === 0 &&
      attachments.length === 0 &&
      notes.length === 0 &&
      sessions.length === 0
    ) {
      if (working()) abort()
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: "Select an agent and model",
        description: "Choose an agent and model before sending a prompt.",
      })
      return
    }

    const errorMessage = (err: unknown) => {
      if (err && typeof err === "object" && "data" in err) {
        const data = (err as { data?: { message?: string } }).data
        if (data?.message) return data.message
      }
      if (err instanceof Error) return err.message
      return "Request failed"
    }

    addToHistory(currentPrompt, mode)
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)

    const projectDirectory = sdk.directory
    const isNewSession = !params.id
    const worktreeSelection = props.newSessionWorktree ?? "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: "Failed to create worktree",
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: "Failed to create worktree",
            description: "Request failed",
          })
          return
        }
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = createSynergyClient({
          baseUrl: sdk.url,
          fetch: platform.fetch,
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      props.onNewSessionWorktreeReset?.()
    }

    let session = info()
    if (!session && isNewSession) {
      if (isGlobalScope(sessionDirectory)) {
        session = await client.channel.app.session().then((x) => x.data ?? undefined)
      } else {
        session = await client.session.create().then((x) => x.data ?? undefined)
      }
      if (session) navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
    }
    if (!session) return

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const variant = local.model.variant.current()

    const clearInput = () => {
      prompt.reset()
      setStore("mode", "normal")
      setStore("popover", null)
    }

    const restoreInput = () => {
      prompt.set(currentPrompt, promptLength(currentPrompt))
      setStore("mode", mode)
      setStore("popover", null)
      requestAnimationFrame(() => {
        editorRef.focus()
        setCursorPosition(editorRef, promptLength(currentPrompt))
        queueScroll()
      })
    }

    if (mode === "shell") {
      clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .catch((err) => {
          showToast({
            title: "Failed to send shell command",
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            variant,
            parts: [
              ...images.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: attachment.mime,
                url: attachment.dataUrl,
                filename: attachment.filename,
              })),
              ...attachments.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: attachment.mime,
                url: attachment.url,
                filename: attachment.filename,
              })),
              ...notes.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: "text/plain",
                url: `data:text/plain;base64,${base64Encode(formatNoteContent(attachment))}`,
                filename: `${attachment.title || "Untitled"}.md`,
                metadata: {
                  kind: "note",
                  noteId: attachment.noteId,
                  title: attachment.title || "Untitled",
                },
              })),
              ...sessions.map((attachment) => ({
                id: Identifier.ascending("part"),
                type: "file" as const,
                mime: "text/plain",
                url: `data:text/plain;base64,${base64Encode(formatSessionReference(attachment))}`,
                filename: `${attachment.title || "session"}.session.txt`,
                metadata: {
                  kind: "session",
                  sessionId: attachment.sessionId,
                  directory: attachment.directory,
                  title: attachment.title || "Untitled",
                  updatedAt: attachment.updatedAt,
                },
              })),
            ],
          })
          .catch((err) => {
            showToast({
              title: "Failed to send command",
              description: errorMessage(err),
            })
            restoreInput()
          })
        return
      }
    }

    const toAbsolutePath = (path: string) =>
      path.startsWith("/") ? path : (sessionDirectory + "/" + path).replace("//", "/")

    const getSessionPreviewData = async (attachment: SessionAttachmentPart) => {
      const [childStore] = globalSync.child(attachment.directory)
      const cachedMessages = childStore.message[attachment.sessionId]
      if (cachedMessages !== undefined) {
        return {
          messages: cachedMessages,
          getParts: (messageID: string) => childStore.part[messageID] ?? [],
        }
      }

      const response = await client.session.messages({
        directory: attachment.directory,
        sessionID: attachment.sessionId,
        limit: SESSION_PREVIEW_MAX_MESSAGES,
      })
      const items = (response.data ?? []).filter((item) => !!item?.info?.id)
      const messages = items
        .map((item) => item.info)
        .filter((message) => !!message?.id)
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
      const partsByMessage = new Map(items.map((item) => [item.info.id, item.parts]))
      return {
        messages,
        getParts: (messageID: string) => partsByMessage.get(messageID) ?? [],
      }
    }

    const createSessionAttachmentPart = async (attachment: SessionAttachmentPart) => {
      let content = formatSessionReference(attachment)
      try {
        const preview = await getSessionPreviewData(attachment)
        content = formatSessionPreview({
          attachment,
          sessionMessages: preview.messages,
          getParts: preview.getParts,
        })
      } catch {}

      return {
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: "text/plain",
        url: `data:text/plain;base64,${base64Encode(content)}`,
        filename: `${attachment.title || "session"}.session.txt`,
        metadata: {
          kind: "session",
          sessionId: attachment.sessionId,
          directory: attachment.directory,
          title: attachment.title || "Untitled",
          updatedAt: attachment.updatedAt,
        },
      }
    }

    const sessionAttachmentParts = await Promise.all(sessions.map(createSessionAttachmentPart))

    const fileAttachments = currentPrompt.filter((part) => part.type === "file") as FileAttachmentPart[]

    const fileAttachmentParts = fileAttachments.map((attachment) => {
      const absolute = toAbsolutePath(attachment.path)
      const query = attachment.selection
        ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
        : ""
      return {
        id: Identifier.ascending("part"),
        type: "file" as const,
        mime: "text/plain",
        url: `file://${absolute}${query}`,
        filename: getFilename(attachment.path),
        source: {
          type: "file" as const,
          text: {
            value: attachment.content,
            start: attachment.start,
            end: attachment.end,
          },
          path: absolute,
        },
      }
    })

    const usedUrls = new Set(fileAttachmentParts.map((part) => part.url))

    const contextFileParts: Array<{
      id: string
      type: "file"
      mime: string
      url: string
      filename?: string
    }> = []

    const addContextFile = (path: string, selection?: FileSelection) => {
      const absolute = toAbsolutePath(path)
      const query = selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""
      const url = `file://${absolute}${query}`
      if (usedUrls.has(url)) return
      usedUrls.add(url)
      contextFileParts.push({
        id: Identifier.ascending("part"),
        type: "file",
        mime: "text/plain",
        url,
        filename: getFilename(path),
      })
    }

    const activePath = activeFile()
    if (activePath && prompt.context.activeTab()) {
      addContextFile(activePath)
    }

    for (const item of prompt.context.items()) {
      if (item.type !== "file") continue
      addContextFile(item.path, item.selection)
    }

    const imageAttachmentParts = images.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    }))

    const uploadedAttachmentParts = attachments.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename,
    }))

    const noteAttachmentParts = notes.map((attachment) => ({
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: "text/plain",
      url: `data:text/plain;base64,${base64Encode(formatNoteContent(attachment))}`,
      filename: `${attachment.title || "Untitled"}.md`,
      metadata: {
        kind: "note",
        noteId: attachment.noteId,
        title: attachment.title || "Untitled",
      },
    }))

    const messageID = Identifier.ascending("message")
    const textPart = {
      id: Identifier.ascending("part"),
      type: "text" as const,
      text,
    }
    const requestParts = [
      textPart,
      ...fileAttachmentParts,
      ...contextFileParts,
      ...imageAttachmentParts,
      ...uploadedAttachmentParts,
      ...noteAttachmentParts,
      ...sessionAttachmentParts,
    ]

    const optimisticParts = requestParts.map((part) => ({
      ...part,
      sessionID: session.id,
      messageID,
    })) as unknown as Part[]

    const optimisticMessage: Message = {
      id: messageID,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }

    const setSyncStore = sessionDirectory === projectDirectory ? sync.set : globalSync.child(sessionDirectory)[1]

    const addOptimisticMessage = () => {
      setSyncStore(
        produce((draft) => {
          const messages = draft.message[session.id]
          if (!messages) {
            draft.message[session.id] = [optimisticMessage]
          } else {
            const result = Binary.search(messages, messageID, (m) => m.id)
            messages.splice(result.index, 0, optimisticMessage)
          }
          draft.part[messageID] = optimisticParts
            .filter((p) => !!p?.id)
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
        }),
      )
    }

    const removeOptimisticMessage = () => {
      setSyncStore(
        produce((draft) => {
          const messages = draft.message[session.id]
          if (messages) {
            const result = Binary.search(messages, messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[messageID]
        }),
      )
    }

    clearInput()
    addOptimisticMessage()

    client.session
      .promptAsync({
        sessionID: session.id,
        agent,
        model,
        messageID,
        parts: requestParts,
        variant,
      })
      .catch((err) => {
        showToast({
          title: "Failed to send prompt",
          description: errorMessage(err),
        })
        removeOptimisticMessage()
        restoreInput()
      })
  }

  return (
    <div class="relative z-0 size-full _max-h-[320px] flex flex-col gap-3 overflow-visible">
      <Show when={params.id}>
        <QuickActions onSend={sendQuickAction} onCommand={(id) => command.trigger(id)} disabled={working()} />
      </Show>
      <Show when={store.popover}>
        <div
          ref={(el) => {
            if (store.popover === "slash") slashPopoverRef = el
          }}
          class="absolute inset-x-0 -top-3 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-md
                 border border-border-base bg-surface-raised-stronger-non-alpha shadow-md"
        >
          <Switch>
            <Match when={store.popover === "at"}>
              <Show
                when={atFlat().length > 0}
                fallback={<div class="text-text-weak px-2 py-1">No matching results</div>}
              >
                <For each={atFlat().slice(0, 10)}>
                  {(item) => (
                    <button
                      classList={{
                        "w-full flex items-center gap-x-2 rounded-md px-2 py-0.5": true,
                        "bg-surface-raised-base-hover": atActive() === atKey(item),
                      }}
                      onClick={() => handleAtSelect(item)}
                    >
                      <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                      <div class="flex items-center text-14-regular min-w-0">
                        <span class="text-text-weak whitespace-nowrap truncate min-w-0">{getDirectory(item.path)}</span>
                        <Show when={!item.path.endsWith("/")}>
                          <span class="text-text-strong whitespace-nowrap">{getFilename(item.path)}</span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Match>
            <Match when={store.popover === "slash"}>
              <Show
                when={slashFlat().length > 0}
                fallback={<div class="text-text-weak px-2 py-1">No matching commands</div>}
              >
                <For each={slashFlat()}>
                  {(cmd) => (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                        "bg-surface-raised-base-hover": slashActive() === cmd.id,
                      }}
                      onClick={() => handleSlashSelect(cmd)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                        <Show when={cmd.description}>
                          <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={cmd.type === "custom"}>
                          <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                            custom
                          </span>
                        </Show>
                        <Show when={command.keybind(cmd.id)}>
                          <span class="text-12-regular text-text-subtle">{command.keybind(cmd.id)}</span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
      <div class="relative">
        <Show when={store.promptBursts.length > 0}>
          <PromptStatusBurst items={store.promptBursts} />
        </Show>
        <form
          onSubmit={handleSubmit}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          classList={{
            "group/prompt-input": true,
            "bg-surface-raised-stronger-non-alpha relative": true,
            "overflow-hidden": true,
            "focus-within:shadow-xs-border": true,
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
            <div class="flex flex-wrap gap-2 px-3 pt-3">
              <For each={imageAttachments()}>
                {(attachment) => (
                  <div class="relative group">
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.filename}
                      class="size-16 rounded-md object-cover border border-border-base"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
                    >
                      <Icon name="x" class="size-3 text-text-weak" />
                    </button>
                    <div class="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md">
                      <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
                    </div>
                  </div>
                )}
              </For>
              <For each={uploadedAttachments()}>
                {(attachment) => (
                  <div class="relative group">
                    <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
                      <FileIcon node={{ path: attachment.filename, type: "file" }} class="shrink-0 size-5" />
                      <span class="text-12-medium text-text-base max-w-[160px] truncate">{attachment.filename}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
                    >
                      <Icon name="x" class="size-3 text-text-weak" />
                    </button>
                  </div>
                )}
              </For>
              <For each={noteAttachments()}>
                {(attachment) => (
                  <div class="relative group">
                    <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
                      <Icon name="notebook-pen" size="small" class="shrink-0 text-text-interactive-base" />
                      <span class="text-12-medium text-text-base max-w-[160px] truncate">
                        {attachment.title || "Untitled"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
                    >
                      <Icon name="x" class="size-3 text-text-weak" />
                    </button>
                  </div>
                )}
              </For>
              <For each={sessionAttachments()}>
                {(attachment) => (
                  <div class="relative group">
                    <div class="h-10 rounded-md bg-surface-base flex items-center gap-2 px-2.5 border border-border-base">
                      <Icon name="message-square" size="small" class="shrink-0 text-text-interactive-base" />
                      <span class="text-12-medium text-text-base max-w-[180px] truncate">
                        {attachment.title || "Untitled"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
                    >
                      <Icon name="x" class="size-3 text-text-weak" />
                    </button>
                  </div>
                )}
              </For>
            </div>
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
                  <div class="hidden md:contents">
                    <TooltipKeybind placement="top" title="Cycle agent" keybind={command.keybind("agent.cycle")}>
                      <ToolbarSelectorPopover
                        trigger={
                          <ToolbarSelectorTrigger
                            icon="bot"
                            label={(local.agent.current()?.name ?? "Agent").replace(/^./, (c) => c.toUpperCase())}
                          />
                        }
                        title="Select agent"
                      >
                        {(close) => (
                          <List
                            class="p-1"
                            items={local.agent
                              .list()
                              .filter(
                                (a) => !a.hidden && a.mode !== "primary" && (!a.external || !sessionHasMessages()),
                              )}
                            current={local.agent.current()}
                            key={(x) => x.name}
                            filterKeys={["name"]}
                            onSelect={(x) => {
                              if (x) local.agent.set(x.name)
                              close()
                            }}
                          >
                            {(agent) => <span class="text-13-regular capitalize">{agent.name}</span>}
                          </List>
                        )}
                      </ToolbarSelectorPopover>
                    </TooltipKeybind>
                    <Show
                      when={!isCurrentAgentExternal()}
                      fallback={
                        <Tooltip placement="top" value="Model is managed by external agent">
                          <button
                            type="button"
                            class="flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-surface-base border border-border-weak-base transition-colors text-12-medium text-text-subtle cursor-default opacity-60"
                          >
                            <Icon name="sparkles" size="small" class="text-icon-weak" />
                            <span>{local.agent.current()?.name ?? "External"}</span>
                          </button>
                        </Tooltip>
                      }
                    >
                      <Show
                        when={providers.paid().length > 0}
                        fallback={
                          <TooltipKeybind
                            placement="top"
                            title="Choose model"
                            keybind={command.keybind("model.choose")}
                          >
                            <button
                              type="button"
                              class="flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-surface-base border border-border-weak-base hover:bg-surface-raised-base-hover transition-colors text-12-medium text-text-base"
                              onClick={() => dialog.show(() => <DialogSelectModelUnpaid />)}
                            >
                              <Icon name="sparkles" size="small" class="text-icon-base" />
                              <span>{local.model.current()?.name ?? "Select model"}</span>
                              <Icon name="chevron-down" size="small" class="text-icon-weak" />
                            </button>
                          </TooltipKeybind>
                        }
                      >
                        <ModelSelectorPopover>
                          <TooltipKeybind
                            placement="top"
                            title="Choose model"
                            keybind={command.keybind("model.choose")}
                          >
                            <button
                              type="button"
                              class="flex items-center gap-1.5 px-2.5 h-7 rounded-full bg-surface-base border border-border-weak-base hover:bg-surface-raised-base-hover transition-colors text-12-medium text-text-base"
                            >
                              <Icon name="sparkles" size="small" class="text-icon-base" />
                              <span>{local.model.current()?.name ?? "Select model"}</span>
                              <Icon name="chevron-down" size="small" class="text-icon-weak" />
                            </button>
                          </TooltipKeybind>
                        </ModelSelectorPopover>
                      </Show>
                    </Show>
                    <Show when={local.model.variant.list().length > 0}>
                      <TooltipKeybind
                        placement="top"
                        title="Thinking effort"
                        keybind={command.keybind("model.variant.cycle")}
                      >
                        <button
                          type="button"
                          class="flex items-center gap-1 px-2.5 h-7 rounded-full border border-transparent hover:border-border-weak-base hover:bg-surface-raised-base-hover transition-colors text-12-regular text-text-weak capitalize"
                          onClick={() => local.model.variant.cycle()}
                        >
                          {local.model.variant.current() ?? "Default"}
                        </button>
                      </TooltipKeybind>
                    </Show>
                  </div>
                  <Show when={store.mode === "normal"}>
                    <Tooltip placement="top" value="Attach file">
                      <button
                        type="button"
                        class="flex items-center justify-center size-7 rounded-full border border-border-weak-base bg-surface-base hover:bg-surface-raised-base-hover transition-colors"
                        onClick={() => fileInputRef.click()}
                      >
                        <Icon name="paperclip" size="small" class="text-icon-base" />
                      </button>
                    </Tooltip>
                  </Show>
                  <Show when={params.id}>
                    <ContextBar />
                  </Show>
                  <Show when={permission.permissionsEnabled() && params.id}>
                    <TooltipKeybind
                      placement="top"
                      title={permission.isAllowingAll(params.id!) ? "Stop allowing all" : "Allow all permissions"}
                      keybind={command.keybind("permissions.allowall")}
                    >
                      <button
                        type="button"
                        classList={{
                          "flex items-center justify-center rounded-full transition-colors": true,
                          "gap-1.5 px-2.5 h-7 border border-border-warning-base bg-surface-warning-base hover:bg-surface-warning-weak text-text-on-warning-base":
                            permission.isAllowingAll(params.id!),
                          "size-7 border border-border-success-base bg-surface-success-weak hover:bg-surface-success-base":
                            !permission.isAllowingAll(params.id!),
                        }}
                        onClick={() => permission.toggleAllowAll(params.id!, sdk.directory)}
                      >
                        <Icon
                          name={permission.isAllowingAll(params.id!) ? "shield-alert" : "shield-check"}
                          size="small"
                          classList={{
                            "text-icon-warning-base": permission.isAllowingAll(params.id!),
                            "text-icon-success-base": !permission.isAllowingAll(params.id!),
                          }}
                        />
                        <Show when={permission.isAllowingAll(params.id!)}>
                          <span class="text-12-medium">Allow All</span>
                        </Show>
                      </button>
                    </TooltipKeybind>
                  </Show>
                </Match>
              </Switch>
            </div>
            <div class="flex items-center gap-2">
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
              <Tooltip
                placement="top"
                inactive={!prompt.dirty() && !working()}
                value={
                  <Switch>
                    <Match when={working()}>
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
                  disabled={!prompt.dirty() && !working()}
                  icon={working() ? "square" : "arrow-up"}
                  variant="primary"
                  class="size-9 rounded-full!"
                />
              </Tooltip>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    } else if (segments.length > 1) {
      fragment.appendChild(document.createTextNode("\u200B"))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

function getNodeLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  return (node.textContent ?? "").replace(/\u200B/g, "").length
}

function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.type === "file"
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      if (remaining === 0) {
        range.setStartBefore(node)
      }
      if (remaining > 0 && isPill) {
        range.setStartAfter(node)
      }
      if (remaining > 0 && isBreak) {
        const next = node.nextSibling
        if (next && next.nodeType === Node.TEXT_NODE) {
          range.setStart(next, 0)
        }
        if (!next || next.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(node)
        }
      }
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const fallbackSelection = window.getSelection()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = last.textContent ? last.textContent.length : 0
    fallbackRange.setStart(last, len)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  fallbackSelection?.removeAllRanges()
  fallbackSelection?.addRange(fallbackRange)
}
