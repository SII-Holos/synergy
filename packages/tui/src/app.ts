import type { PermissionRequest, QuestionAnswer, QuestionRequest, Session } from "@ericsanchezok/synergy-sdk/client"
import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  DiffRenderable,
  type KeyEvent,
  MarkdownRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"
import type { TuiController } from "./controller.js"
import { createInputHistory } from "./input-history.js"
import { resolveKeyCommand } from "./key-commands.js"
import type { TuiState } from "./reducer.js"
import { sanitizeTerminalLabel, sanitizeTerminalText } from "./sanitization.js"
import { buildMessageView, type ViewBlock, type ViewTone } from "./view-model.js"
import { getTuiPalette, type TuiPalette } from "./theme.js"

function createToneColors(palette: TuiPalette): Record<ViewTone, string> {
  return {
    normal: palette.text,
    muted: palette.textWeaker,
    accent: palette.interactive,
    success: palette.success,
    warning: palette.warning,
    danger: palette.danger,
  }
}

function createMarkdownStyle(palette: TuiPalette) {
  return SyntaxStyle.fromStyles({
    "markup.heading": { fg: palette.textStrong, bold: true },
    "markup.strong": { fg: palette.textStrong, bold: true },
    "markup.italic": { fg: palette.textWeak, italic: true },
    "markup.quote": { fg: palette.textWeaker, italic: true },
    "markup.list": { fg: palette.textWeak },
    "markup.raw": { fg: palette.textWeak },
    "markup.link": { fg: palette.interactive, underline: true },
    "markup.link.url": { fg: palette.textWeaker, underline: true },
    "markup.link.label": { fg: palette.interactive, underline: true },
  })
}

export type TuiAppOptions = {
  renderer?: CliRenderer
  onQuit?: () => void
  compactBreakpoint?: number
  theme?: "system" | "light" | "dark"
}

export type TuiApp = {
  readonly renderer: CliRenderer
  readonly done: Promise<void>
  start(): Promise<void>
  stop(): void
  focusComposer(): void
}

type ModalState =
  | { kind: "commands" }
  | { kind: "sessions" }
  | { kind: "permission"; request: PermissionRequest }
  | { kind: "question"; request: QuestionRequest; index: number; answers: QuestionAnswer[] }

function statusSymbol(state: TuiState, sessionID: string) {
  const status = state.sessionStatus[sessionID]
  if (!status || status.type === "idle") return "○"
  if (status.type === "busy") return "●"
  if (status.type === "retry") return "↻"
  return "◐"
}

function statusLabel(state: TuiState) {
  const active = state.activeSessionID ? state.sessionStatus[state.activeSessionID] : undefined
  const session = active?.type ?? "idle"
  const sync = state.sync.seq === undefined ? "unsequenced" : `seq ${state.sync.seq}`
  return `${state.connection} · ${session} · ${sync}`
}

function sessionDescription(session: Session) {
  const agent = session.agentOverride ?? session.controlProfile ?? "default"
  const pin = session.pinned ? " · pinned" : ""
  return `${sanitizeTerminalLabel(agent, "default")}${pin}`
}

function clearChildren(container: BoxRenderable | ScrollBoxRenderable) {
  const target = container instanceof ScrollBoxRenderable ? container.content : container
  for (const child of target.getChildren()) {
    target.remove(child)
    child.destroyRecursively()
  }
}

function addText(
  renderer: CliRenderer,
  parent: BoxRenderable,
  content: string,
  color: string,
  options: { bold?: boolean; marginTop?: number } = {},
) {
  const text = new TextRenderable(renderer, {
    content,
    fg: color,
    wrapMode: "word",
    flexShrink: 0,
    marginTop: options.marginTop,
    attributes: options.bold ? 1 : 0,
  })
  parent.add(text)
  return text
}

function blockRenderable(
  renderer: CliRenderer,
  syntaxStyle: SyntaxStyle,
  palette: TuiPalette,
  toneColor: Record<ViewTone, string>,
  block: ViewBlock,
  toggle: () => void,
) {
  const container = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexShrink: 0,
    marginTop: 1,
    paddingLeft: 1,
    ...(block.collapsible ? { border: ["left"] as const, borderColor: toneColor[block.tone] } : {}),
    onMouseDown: block.collapsible ? toggle : undefined,
  })
  if (block.kind === "markdown") {
    container.add(
      new MarkdownRenderable(renderer, {
        content: block.content,
        syntaxStyle,
        fg: toneColor[block.tone],
        conceal: true,
        streaming: true,
        flexShrink: 0,
      }),
    )
    return container
  }
  if (block.kind === "diff") {
    const newline = block.content.indexOf("\n")
    const summary = newline < 0 ? block.content : block.content.slice(0, newline)
    const diff = newline < 0 ? "" : block.content.slice(newline + 1)
    addText(renderer, container, summary, toneColor[block.tone], { bold: true })
    if (diff) {
      container.add(
        new DiffRenderable(renderer, {
          diff,
          view: "unified",
          wrapMode: "word",
          syntaxStyle,
          showLineNumbers: false,
          addedBg: palette.addedBackground,
          removedBg: palette.removedBackground,
          contextBg: palette.surface,
          flexShrink: 0,
        }),
      )
    }
    return container
  }
  addText(renderer, container, block.content, toneColor[block.tone])
  return container
}

export async function createTuiApp(controller: TuiController, options: TuiAppOptions = {}): Promise<TuiApp> {
  const requestedTheme = options.theme ?? "system"
  const initialPalette = getTuiPalette(requestedTheme === "light" ? "light" : "dark")
  const renderer =
    options.renderer ??
    (await createCliRenderer({
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      clearOnShutdown: true,
      useMouse: true,
      autoFocus: true,
      ...(requestedTheme === "system" ? {} : { backgroundColor: initialPalette.background }),
      useKittyKeyboard: { disambiguate: true, alternateKeys: true },
    }))
  const theme = requestedTheme === "system" ? (renderer.themeMode ?? "dark") : requestedTheme
  const COLOR = getTuiPalette(theme)
  const toneColor = createToneColors(COLOR)
  const markdownStyle = createMarkdownStyle(COLOR)
  const compactBreakpoint = options.compactBreakpoint ?? 84
  const history = createInputHistory()
  const expanded = new Set<string>()
  const ignoredInteractions = new Set<string>()
  const messageNodes = new Map<string, { node: BoxRenderable; revision: number }>()
  let messageOrderSignature = ""
  let compactLayout = renderer.width < compactBreakpoint
  let state = controller.getState()
  let modal: ModalState | undefined
  let unsubscribed = false
  let started = false
  let stopped = false
  let pendingRefresh = false
  let localError: string | undefined
  let unsubscribe = () => {}
  let resolveDone = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const root = new BoxRenderable(renderer, {
    id: "tui-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLOR.background,
  })
  const header = new BoxRenderable(renderer, {
    id: "tui-header",
    height: 3,
    flexShrink: 0,
    border: ["bottom"],
    borderColor: COLOR.borderHairline,
    paddingX: 2,
    flexDirection: "row",
    justifyContent: "space-between",
  })
  const brandText = new TextRenderable(renderer, {
    content: "HOLOS / SYNERGY",
    fg: COLOR.textStrong,
    attributes: 1,
  })
  const scopeText = new TextRenderable(renderer, { content: "connecting", fg: COLOR.textWeaker })
  header.add(brandText)
  header.add(scopeText)

  const body = new BoxRenderable(renderer, {
    id: "tui-body",
    flexGrow: 1,
    minHeight: 0,
    flexDirection: "row",
  })
  const sidebar = new BoxRenderable(renderer, {
    id: "tui-sidebar",
    width: 30,
    minWidth: 24,
    maxWidth: 38,
    flexShrink: 0,
    border: ["right"],
    borderColor: COLOR.borderHairline,
    backgroundColor: COLOR.surfaceInset,
    flexDirection: "column",
    padding: 1,
  })
  const sessionTitle = new TextRenderable(renderer, {
    content: "SESSIONS",
    fg: COLOR.textWeaker,
    attributes: 1,
  })
  const sessionSelect = new SelectRenderable(renderer, {
    id: "tui-sessions",
    flexGrow: 1,
    minHeight: 2,
    options: [],
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: true,
    textColor: COLOR.text,
    descriptionColor: COLOR.textWeaker,
    selectedBackgroundColor: COLOR.selected,
    selectedTextColor: COLOR.selectedText,
    focusedBackgroundColor: COLOR.surface,
    focusedTextColor: COLOR.textStrong,
  })
  sidebar.add(sessionTitle)
  sidebar.add(sessionSelect)

  const main = new BoxRenderable(renderer, {
    id: "tui-main",
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "column",
  })
  const timeline = new ScrollBoxRenderable(renderer, {
    id: "tui-timeline",
    flexGrow: 1,
    minHeight: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    viewportCulling: true,
    contentOptions: { flexDirection: "column", paddingX: 2, paddingBottom: 1 },
    verticalScrollbarOptions: { visible: true },
  })
  const resources = new BoxRenderable(renderer, {
    id: "tui-resources",
    height: 3,
    flexShrink: 0,
    border: ["top"],
    borderColor: COLOR.borderHairline,
    paddingX: 2,
    flexDirection: "column",
  })
  const resourcesText = new TextRenderable(renderer, { content: "", fg: COLOR.textWeaker, wrapMode: "word" })
  resources.add(resourcesText)
  const composerBox = new BoxRenderable(renderer, {
    id: "tui-composer-box",
    height: 5,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.border,
    focusedBorderColor: COLOR.borderFocus,
    backgroundColor: COLOR.surfaceRaised,
    title: " ASK SYNERGY ",
    titleColor: COLOR.textWeak,
    bottomTitle: " Enter send · Shift+Enter newline · Ctrl+K commands ",
    bottomTitleAlignment: "right",
    paddingX: 1,
  })
  const composer = new TextareaRenderable(renderer, {
    id: "tui-composer",
    width: "100%",
    height: "100%",
    placeholder: "Write a message or /command…",
    wrapMode: "word",
    textColor: COLOR.text,
    backgroundColor: COLOR.surfaceRaised,
    focusedTextColor: COLOR.textStrong,
    focusedBackgroundColor: COLOR.surfaceRaised,
    cursorColor: COLOR.interactive,
  })
  composer.traits = { capture: ["escape", "submit", "tab"] }
  composerBox.add(composer)
  main.add(timeline)
  main.add(resources)
  main.add(composerBox)
  body.add(sidebar)
  body.add(main)

  const footer = new BoxRenderable(renderer, {
    id: "tui-footer",
    height: 1,
    flexShrink: 0,
    paddingX: 1,
    flexDirection: "row",
    justifyContent: "space-between",
  })
  const statusText = new TextRenderable(renderer, { content: "offline", fg: COLOR.textWeaker })
  const helpText = new TextRenderable(renderer, {
    content: "Ctrl+N new · Ctrl+P pin · Ctrl+C abort/quit · Tab focus",
    fg: COLOR.textSubtle,
  })
  footer.add(statusText)
  footer.add(helpText)

  const overlay = new BoxRenderable(renderer, {
    id: "tui-overlay",
    position: "absolute",
    top: 2,
    left: "15%",
    width: "70%",
    maxHeight: "75%",
    zIndex: 100,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR.borderStrong,
    backgroundColor: COLOR.surfaceRaised,
    bottomTitle: " ↑↓ navigate · Enter choose · Esc close ",
    bottomTitleAlignment: "center",
    titleColor: COLOR.textWeaker,
    padding: 1,
    flexDirection: "column",
  })
  const modalTitle = new TextRenderable(renderer, { content: "", fg: COLOR.textStrong, attributes: 1 })
  const modalBody = new TextRenderable(renderer, {
    content: "",
    fg: COLOR.textWeak,
    wrapMode: "word",
    flexShrink: 0,
    marginTop: 1,
  })
  const modalSelect = new SelectRenderable(renderer, {
    id: "tui-modal-select",
    minHeight: 2,
    maxHeight: 14,
    flexGrow: 1,
    options: [],
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: true,
    textColor: COLOR.text,
    descriptionColor: COLOR.textWeaker,
    selectedBackgroundColor: COLOR.selected,
    selectedTextColor: COLOR.selectedText,
    focusedBackgroundColor: COLOR.surfaceInset,
    focusedTextColor: COLOR.textStrong,
  })
  overlay.add(modalTitle)
  overlay.add(modalBody)
  overlay.add(modalSelect)

  root.add(header)
  root.add(body)
  root.add(footer)
  root.add(overlay)
  renderer.root.add(root)

  const setError = (error: unknown) => {
    localError = error instanceof Error ? error.message : String(error)
    scheduleRefresh()
  }

  const run = (operation: () => Promise<unknown>) => {
    localError = undefined
    void operation().catch(setError)
  }

  const activePermissions = () => {
    if (!state.activeSessionID) return []
    return (state.permissions[state.activeSessionID] ?? []).filter((request) => !ignoredInteractions.has(request.id))
  }

  const activeQuestions = () => {
    if (!state.activeSessionID) return []
    return (state.questions[state.activeSessionID] ?? []).filter((request) => !ignoredInteractions.has(request.id))
  }

  const syncInteractionModal = () => {
    if (modal?.kind === "commands" || modal?.kind === "sessions") return
    if (modal?.kind === "permission") {
      const requestID = modal.request.id
      if (activePermissions().some((request) => request.id === requestID)) return
    }
    if (modal?.kind === "question") {
      const requestID = modal.request.id
      if (activeQuestions().some((request) => request.id === requestID)) return
    }
    const permission = activePermissions()[0]
    if (permission) {
      modal = { kind: "permission", request: permission }
      return
    }
    const question = activeQuestions()[0]
    modal = question ? { kind: "question", request: question, index: 0, answers: [] } : undefined
  }

  const renderSessions = () => {
    const optionsList: SelectOption[] = state.sessions.map((session) => ({
      name: `${statusSymbol(state, session.id)} ${sanitizeTerminalLabel(session.title, "Untitled session")}`,
      description: sessionDescription(session),
      value: session.id,
    }))
    sessionSelect.options = optionsList
    const selectedIndex = Math.max(
      0,
      state.sessions.findIndex((session) => session.id === state.activeSessionID),
    )
    if (optionsList.length) sessionSelect.setSelectedIndex(selectedIndex)
  }

  const resetMessages = () => {
    clearChildren(timeline)
    messageNodes.clear()
  }

  const createMessageNode = (messageID: string) => {
    const sessionID = state.activeSessionID
    const conversation = sessionID ? state.conversations[sessionID] : undefined
    const message = conversation?.messages[messageID]
    if (!message || !conversation) return undefined
    const parts = (conversation.partsByMessage[messageID] ?? [])
      .map((partID) => conversation.parts[partID])
      .filter((part) => part !== undefined)
    const view = buildMessageView(message, parts, { expandedReasoning: expanded })
    const revision = conversation.messageRevisions[messageID] ?? 0
    const node = new BoxRenderable(renderer, {
      id: `message:${view.id}`,
      flexDirection: "column",
      flexShrink: 0,
      marginTop: 1,
      paddingY: 1,
    })
    const top = new BoxRenderable(renderer, { flexDirection: "row", justifyContent: "space-between", flexShrink: 0 })
    top.add(
      new TextRenderable(renderer, {
        content: message.role === "user" ? `› ${view.label}` : `◆ ${view.label}`,
        fg: message.role === "user" ? COLOR.textStrong : COLOR.textWeak,
        attributes: 1,
      }),
    )
    top.add(
      new TextRenderable(renderer, { content: compactLayout ? view.compactMeta : view.meta, fg: COLOR.textSubtle }),
    )
    node.add(top)
    for (const block of view.blocks) {
      node.add(
        blockRenderable(renderer, markdownStyle, COLOR, toneColor, block, () => {
          if (!block.collapsible) return
          if (expanded.has(block.id)) expanded.delete(block.id)
          else expanded.add(block.id)
          refreshMessages(true)
        }),
      )
    }
    return { node, revision }
  }

  const refreshMessages = (forceRebuild = false) => {
    const sessionID = state.activeSessionID
    const conversation = sessionID ? state.conversations[sessionID] : undefined
    const order = conversation?.messageOrder ?? []
    const nextOrderSignature = `${sessionID ?? ""}:${order.join(",")}`
    if (forceRebuild || nextOrderSignature !== messageOrderSignature) {
      resetMessages()
      messageOrderSignature = nextOrderSignature
    }
    const retained = new Set(order)
    for (const [messageID, current] of messageNodes) {
      if (retained.has(messageID)) continue
      timeline.content.remove(current.node)
      current.node.destroyRecursively()
      messageNodes.delete(messageID)
    }
    for (const [index, messageID] of order.entries()) {
      const conversationRevision = conversation?.messageRevisions[messageID]
      if (conversationRevision === undefined) continue
      const current = messageNodes.get(messageID)
      if (current?.revision === conversationRevision) continue
      const next = createMessageNode(messageID)
      if (!next) continue
      if (current) {
        timeline.content.remove(current.node)
        current.node.destroyRecursively()
      }
      timeline.content.add(next.node, index)
      messageNodes.set(messageID, next)
    }
    const empty = timeline.content.getRenderable("tui-empty-message")
    if (empty && order.length > 0) {
      timeline.content.remove(empty)
      empty.destroyRecursively()
    }
    if (order.length === 0 && !empty) {
      const emptyState = new BoxRenderable(renderer, {
        id: "tui-empty-message",
        flexGrow: 1,
        minHeight: 8,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
      })
      emptyState.add(
        new TextRenderable(renderer, {
          content: state.activeSessionID ? "H O L O S\nS Y N E R G Y" : "H O L O S / S Y N E R G Y",
          fg: COLOR.textStrong,
          attributes: 1,
        }),
      )
      emptyState.add(
        new TextRenderable(renderer, {
          content: state.activeSessionID
            ? "Start with a question, command, or plan."
            : "Create or choose a session to begin.",
          fg: COLOR.textWeaker,
          marginTop: 1,
        }),
      )
      timeline.content.add(emptyState)
    }
  }

  const renderResources = () => {
    const sessionID = state.activeSessionID
    const todos = sessionID ? (state.todos[sessionID] ?? []) : []
    const dag = sessionID ? (state.dag[sessionID] ?? []) : []
    const activeTodos = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")
    const activeDag = dag.filter((node) => node.status === "running" || node.status === "blocked")
    const todoSummary = activeTodos
      .slice(0, 2)
      .map((todo) => sanitizeTerminalLabel(todo.content, "Unnamed task"))
      .join(" · ")
    const dagSummary = activeDag
      .slice(0, 2)
      .map((node) => `${node.status}: ${sanitizeTerminalLabel(node.content, "Unnamed DAG node")}`)
      .join(" · ")
    resourcesText.content = `Tasks ${activeTodos.length}/${todos.length}${todoSummary ? ` · ${todoSummary}` : ""}\nDAG ${activeDag.length}/${dag.length}${dagSummary ? ` · ${dagSummary}` : ""}`
  }

  const renderModal = () => {
    overlay.visible = modal !== undefined
    if (!modal) return
    overlay.borderColor = COLOR.borderStrong
    modalTitle.fg = COLOR.textStrong
    if (modal.kind === "sessions") {
      modalTitle.content = "SESSIONS"
      modalBody.content = "Choose a session to open."
      modalSelect.options = state.sessions.map((session) => ({
        name: `${statusSymbol(state, session.id)} ${sanitizeTerminalLabel(session.title, "Untitled session")}`,
        description: sessionDescription(session),
        value: session.id,
      }))
    } else if (modal.kind === "commands") {
      modalTitle.content = "COMMAND PALETTE"
      modalBody.content = "Choose a command. It will be inserted into the composer for review."
      modalSelect.options = state.commands
        .filter((command) => command.promptVisible !== false)
        .map((command) => ({
          name: `/${sanitizeTerminalLabel(command.name, "unnamed-command")}`,
          description: sanitizeTerminalLabel(
            command.description ?? command.hints[0] ?? "Synergy command",
            "Synergy command",
          ),
          value: command.name,
        }))
    } else if (modal.kind === "permission") {
      const request = modal.request
      overlay.borderColor = COLOR.warning
      modalTitle.fg = COLOR.warning
      modalTitle.content = `PERMISSION · ${sanitizeTerminalLabel(request.permission, "unknown permission")}`
      const patterns = request.patterns.map((pattern) => sanitizeTerminalLabel(pattern, "(hidden pattern)")).join("\n")
      modalBody.content = `Review the requested capability and affected pattern:\n${patterns || "(no pattern details)"}`
      modalSelect.options = [
        { name: "Allow once", description: "Approve this request only", value: "once" },
        { name: "Allow for session", description: "Approve matching requests in this session", value: "session" },
        { name: "Always allow", description: "Persist approval according to runtime policy", value: "always" },
        { name: "Reject", description: "Deny this request", value: "reject" },
      ]
    } else {
      const question = modal.request.questions[modal.index]
      if (!question) return
      overlay.borderColor = COLOR.interactive
      modalTitle.fg = COLOR.interactive
      const selected = new Set(modal.answers[modal.index] ?? [])
      modalTitle.content = `QUESTION ${modal.index + 1}/${modal.request.questions.length} · ${sanitizeTerminalLabel(question.header, "Question")}`
      modalBody.content = sanitizeTerminalText(question.question)
      const questionOptions: SelectOption[] = question.options.map((option) => ({
        name: `${selected.has(option.label) ? "✓" : question.multiple ? "○" : "›"} ${sanitizeTerminalLabel(option.label, "Option")}`,
        description: sanitizeTerminalLabel(option.description, "No description"),
        value: option.label,
      }))
      if (question.multiple) {
        questionOptions.push({
          name: "Continue",
          description: selected.size ? `Submit ${selected.size} selection(s)` : "Submit an empty selection",
          value: "__continue__",
        })
      }
      modalSelect.options = questionOptions
    }
    modalSelect.setSelectedIndex(0)
    modalSelect.focus()
  }

  const refresh = () => {
    pendingRefresh = false
    if (stopped) return
    syncInteractionModal()
    const compact = renderer.width < compactBreakpoint
    const compactChanged = compact !== compactLayout
    compactLayout = compact
    sidebar.visible = !compact
    scopeText.content = compact
      ? `${state.sessions.length} sessions`
      : `${state.scopeID ? sanitizeTerminalLabel(state.scopeID.slice(0, 12), "unknown scope") : "no scope"} · ${state.sessions.length} sessions`
    const connectionGlyph = state.connection === "live" ? "●" : state.connection === "offline" ? "○" : "◐"
    statusText.content = localError
      ? `✕ error · ${sanitizeTerminalLabel(localError, "Unknown error")}`
      : `${connectionGlyph} ${statusLabel(state)}`
    statusText.fg = localError
      ? COLOR.danger
      : state.connection === "live"
        ? COLOR.success
        : state.connection === "offline"
          ? COLOR.danger
          : COLOR.warning
    const activeStatus = state.activeSessionID ? state.sessionStatus[state.activeSessionID] : undefined
    const busy = activeStatus !== undefined && activeStatus.type !== "idle"
    helpText.content = modal
      ? "↑↓ navigate · Enter choose · Esc close"
      : compact
        ? busy
          ? "Ctrl+C abort · Ctrl+K commands · Tab sessions"
          : "Ctrl+K commands · Tab sessions · Ctrl+C quit"
        : busy
          ? "Ctrl+C abort · Ctrl+K commands · Tab focus"
          : "Ctrl+N new · Ctrl+P pin · Ctrl+K commands · Tab focus"
    renderSessions()
    refreshMessages(compactChanged)
    renderResources()
    renderModal()
    renderer.requestRender()
  }

  function scheduleRefresh() {
    if (pendingRefresh || stopped) return
    pendingRefresh = true
    queueMicrotask(refresh)
  }

  const dismissModal = () => {
    if (modal?.kind === "permission") {
      const requestID = modal.request.id
      ignoredInteractions.add(requestID)
      run(() => controller.replyPermission(requestID, "reject"))
    } else if (modal?.kind === "question") {
      const requestID = modal.request.id
      ignoredInteractions.add(requestID)
      run(() => controller.rejectQuestion(requestID))
    }
    modal = undefined
    composer.focus()
    scheduleRefresh()
  }

  const advanceQuestion = (answer: QuestionAnswer) => {
    if (modal?.kind !== "question") return
    const answers = modal.answers.slice()
    answers[modal.index] = answer
    if (modal.index < modal.request.questions.length - 1) {
      modal = { ...modal, index: modal.index + 1, answers }
      renderModal()
      return
    }
    const requestID = modal.request.id
    ignoredInteractions.add(requestID)
    modal = undefined
    run(() => controller.replyQuestion(requestID, answers))
    composer.focus()
    scheduleRefresh()
  }

  modalSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    if (!modal) return
    if (modal.kind === "sessions") {
      const sessionID = String(option.value)
      modal = undefined
      composer.focus()
      run(() => controller.selectSession(sessionID))
      scheduleRefresh()
      return
    }
    if (modal.kind === "commands") {
      composer.setText(`/${String(option.value)} `)
      composer.gotoBufferEnd()
      modal = undefined
      composer.focus()
      scheduleRefresh()
      return
    }
    if (modal.kind === "permission") {
      const requestID = modal.request.id
      const reply = option.value as "once" | "session" | "always" | "reject"
      ignoredInteractions.add(requestID)
      modal = undefined
      run(() => controller.replyPermission(requestID, reply))
      composer.focus()
      scheduleRefresh()
      return
    }
    const question = modal.request.questions[modal.index]
    if (!question) return
    const value = String(option.value)
    if (!question.multiple) {
      advanceQuestion([value])
      return
    }
    const answers = modal.answers.slice()
    const selected = new Set(answers[modal.index] ?? [])
    if (value === "__continue__") {
      advanceQuestion([...selected])
      return
    }
    if (selected.has(value)) selected.delete(value)
    else selected.add(value)
    answers[modal.index] = [...selected]
    modal = { ...modal, answers }
    renderModal()
  })

  sessionSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    const sessionID = String(option.value)
    if (sessionID === state.activeSessionID) {
      composer.focus()
      return
    }
    run(() => controller.selectSession(sessionID))
  })

  const submitComposer = () => {
    const value = composer.plainText
    const normalized = value.trim()
    if (!normalized) return
    history.record(normalized)
    composer.clear()
    if (normalized.startsWith("/")) {
      const [command = "", ...argumentsList] = normalized.slice(1).split(/\s+/)
      run(() => controller.sendCommand(command, argumentsList.join(" ")))
    } else {
      run(() => controller.sendInput(normalized))
    }
  }

  const focusNext = (_reverse: boolean) => {
    if (modal) {
      modalSelect.focus()
      return
    }
    if (!state.sessions.length) {
      composer.focus()
      return
    }
    if (!sidebar.visible) {
      modal = { kind: "sessions" }
      renderModal()
      return
    }
    if (composer.focused) sessionSelect.focus()
    else composer.focus()
  }

  const onKey = (key: KeyEvent) => {
    const sessionID = state.activeSessionID
    const sessionStatus = sessionID ? state.sessionStatus[sessionID] : undefined
    const sessionBusy = sessionStatus !== undefined && sessionStatus.type !== "idle"
    const command = resolveKeyCommand(
      { name: key.name, ctrl: key.ctrl, alt: key.option, shift: key.shift, meta: key.meta },
      {
        modalOpen: modal !== undefined,
        composerFocused: composer.focused,
        sessionActive: sessionID !== undefined,
        sessionBusy,
      },
    )
    if (!command) return
    if (command === "insert-newline") {
      key.preventDefault()
      key.stopPropagation()
      composer.newLine()
      return
    }
    key.preventDefault()
    key.stopPropagation()
    switch (command) {
      case "quit":
        options.onQuit?.()
        app.stop()
        return
      case "abort-session":
        run(() => controller.abort())
        return
      case "create-session":
        run(() => controller.createSession())
        return
      case "toggle-pin":
        if (sessionID) run(() => controller.togglePin(sessionID))
        return
      case "open-command-palette":
        modal = { kind: "commands" }
        renderModal()
        return
      case "dismiss-modal":
        dismissModal()
        return
      case "blur-composer":
        composer.blur()
        if (sidebar.visible) sessionSelect.focus()
        return
      case "focus-next":
        focusNext(false)
        return
      case "focus-previous":
        focusNext(true)
        return
      case "send-input":
        submitComposer()
        return
      case "history-previous": {
        if (composer.logicalCursor.row > 0) return
        const value = history.previous(composer.plainText)
        if (value !== undefined) {
          composer.setText(value)
          composer.gotoBufferEnd()
        }
        return
      }
      case "history-next": {
        if (composer.logicalCursor.row < composer.lineCount - 1) return
        const value = history.next()
        if (value !== undefined) {
          composer.setText(value)
          composer.gotoBufferEnd()
        }
        return
      }
    }
  }

  const onResize = () => scheduleRefresh()
  renderer.keyInput.on("keypress", onKey)
  renderer.on(CliRenderEvents.RESIZE, onResize)

  const app: TuiApp = {
    renderer,
    done,
    async start() {
      if (started) return
      started = true
      unsubscribe = controller.subscribe((next) => {
        state = next
        for (const requestID of ignoredInteractions) {
          const stillPresent =
            Object.values(next.permissions).some((items) => items.some((item) => item.id === requestID)) ||
            Object.values(next.questions).some((items) => items.some((item) => item.id === requestID))
          if (!stillPresent) ignoredInteractions.delete(requestID)
        }
        scheduleRefresh()
      })
      composer.focus()
      refresh()
      try {
        await controller.start()
      } catch (error) {
        setError(error)
        throw error
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      controller.stop()
      if (!unsubscribed) {
        unsubscribed = true
        unsubscribe()
      }
      renderer.keyInput.off("keypress", onKey)
      renderer.off(CliRenderEvents.RESIZE, onResize)
      renderer.destroy()
      markdownStyle.destroy()
      resolveDone()
    },
    focusComposer() {
      composer.focus()
    },
  }

  return app
}
