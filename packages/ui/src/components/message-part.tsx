import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  onCleanup,
  type JSX,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore, reconcile } from "solid-js/store"
import {
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  TextPart,
  ToolPart,
  ToolStateCompleted,
  UserMessage,
  Todo,
} from "@ericsanchezok/synergy-sdk"
import { useData } from "../context"
import { useDiffComponent } from "../context/diff"
import { useCodeComponent } from "../context/code"
import { useDialog } from "../context/dialog"
import { BasicTool } from "./basic-tool"
import { GenericTool } from "./basic-tool"
import { Card } from "./card"
import { Icon } from "./icon"
import { Checkbox } from "./checkbox"
import { DagGraph } from "./dag-graph"
import { DiffChanges } from "./diff-changes"
import { Markdown } from "./markdown"
import { ImagePreview } from "./image-preview"
import { FileIcon } from "./file-icon"
import { getDirectory as _getDirectory, getFilename } from "@ericsanchezok/synergy-util/path"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { parsePartialJson } from "@ericsanchezok/synergy-util/json"
import { createAutoScroll, createTypewriter } from "../hooks"

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

export function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

export function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">Error</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_THROTTLE_MS = 100

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function createThrottledValue(getValue: () => string) {
  const [value, setValue] = createSignal(getValue())
  let timeout: ReturnType<typeof setTimeout> | undefined
  let last = 0

  createEffect(() => {
    const next = getValue()
    const now = Date.now()
    const remaining = TEXT_RENDER_THROTTLE_MS - (now - last)
    if (remaining <= 0) {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      last = now
      setValue(next)
      return
    }
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      last = Date.now()
      setValue(next)
      timeout = undefined
    }, remaining)
  })

  onCleanup(() => {
    if (timeout) clearTimeout(timeout)
  })

  return value
}

function relativizeProjectPaths(text: string, directory?: string) {
  if (!text) return ""
  if (!directory) return text
  return text.split(directory).join("")
}

export function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPaths(_getDirectory(path), data.directory)
}

export function getSessionToolParts(store: ReturnType<typeof useData>["store"], sessionId: string): ToolPart[] {
  const messages = store.message[sessionId]?.filter((m) => m.role === "assistant")
  if (!messages) return []

  const parts: ToolPart[] = []
  for (const m of messages) {
    const msgParts = store.part[m.id]
    if (msgParts) {
      for (const p of msgParts) {
        if (p && p.type === "tool") parts.push(p as ToolPart)
      }
    }
  }
  return parts
}

import type { IconName } from "./icon"

export type ToolInfo = {
  icon: IconName
  title: string
  subtitle?: string
}

export function getToolInfo(tool: string, input: any = {}): ToolInfo {
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: "Read",
        subtitle: input.filePath ? getDirectory(input.filePath) + getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "folder",
        title: "List",
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "search",
        title: "Glob",
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "search",
        title: "Grep",
        subtitle: input.pattern,
      }
    case "webfetch":
      return {
        icon: "mouse-pointer-2",
        title: "Webfetch",
        subtitle: input.url,
      }
    case "task":
      return {
        icon: "list-todo",
        title: `${input.subagent_type || "task"} Agent`,
        subtitle: input.description,
      }
    case "bash":
      return {
        icon: "terminal",
        title: "Shell",
        subtitle: input.description,
      }
    case "edit":
      return {
        icon: "pen-line",
        title: "Edit",
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "multiedit":
      return {
        icon: "pen-line",
        title: "Multi Edit",
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "patch":
      return {
        icon: "text-select",
        title: "Patch",
      }
    case "write":
      return {
        icon: "text-select",
        title: "Write",
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "todowrite":
      return {
        icon: "list-checks",
        title: "To-dos",
      }
    case "todoread":
      return {
        icon: "list-checks",
        title: "Read to-dos",
      }
    case "dagwrite":
      return {
        icon: "git-branch",
        title: "DAG",
      }
    case "dagread":
      return {
        icon: "git-branch",
        title: "Read DAG",
      }
    case "dagpatch":
      return {
        icon: "git-branch",
        title: "DAG",
      }
    case "question":
      return {
        icon: "message-circle",
        title: "Questions",
      }
    case "websearch":
      return {
        icon: "globe",
        title: "Web Search",
        subtitle: input.query,
      }
    case "look_at":
      return {
        icon: "eye",
        title: "Look at",
        subtitle: input.file_path
          ? getFilename(Array.isArray(input.file_path) ? input.file_path[0] : input.file_path)
          : undefined,
      }
    case "ast_grep":
      return {
        icon: "code",
        title: "AST Search",
        subtitle: input.pattern,
      }
    case "codesearch":
      return {
        icon: "code",
        title: "Code Search",
        subtitle: input.query,
      }
    case "lsp":
      return {
        icon: "server",
        title: "LSP",
        subtitle: input.operation,
      }
    case "skill":
      return {
        icon: "sparkles",
        title: "Skill",
        subtitle: input.name,
      }
    case "arxiv_search":
      return {
        icon: "file-text",
        title: "arXiv Search",
        subtitle: input.query,
      }
    case "arxiv_download":
      return {
        icon: "download",
        title: "arXiv Download",
        subtitle: input.arxivId,
      }
    case "process":
      return {
        icon: "terminal",
        title: "Process",
        subtitle: input.action,
      }
    case "attach":
      return {
        icon: "paperclip",
        title: "Attach",
        subtitle: input.filename || input.file_path,
      }
    case "diagram":
      return {
        icon: "workflow",
        title: "Diagram",
        subtitle: input.title,
      }
    case "note_list":
      return {
        icon: "notebook-pen",
        title: "Notes",
        subtitle: input.scope,
      }
    case "note_read":
      return {
        icon: "notebook-pen",
        title: "Read Note",
        subtitle: Array.isArray(input.ids)
          ? input.ids.length === 1
            ? input.ids[0]
            : `${input.ids.length} notes`
          : undefined,
      }
    case "note_search":
      return {
        icon: "notebook-pen",
        title: "Note Search",
        subtitle: input.pattern,
      }
    case "note_write":
      return {
        icon: "notebook-pen",
        title: "Write Note",
        subtitle: input.title || input.mode,
      }
    case "task_list":
      return {
        icon: "list-todo",
        title: "Task List",
        subtitle: "Visible background tasks",
      }
    case "task_output":
      return {
        icon: "list-todo",
        title: "Task Output",
        subtitle: input.task_id,
      }
    case "task_cancel":
      return {
        icon: "x",
        title: "Task Cancel",
        subtitle: input.task_id,
      }
    case "context7_resolve-library-id":
      return {
        icon: "tag",
        title: "Resolve Library",
        subtitle: input.libraryName,
      }
    case "context7_query-docs":
      return {
        icon: "glasses",
        title: "Query Docs",
        subtitle: input.query,
      }
    case "session_list":
      return {
        icon: "list",
        title: "Sessions",
        subtitle: input.scope,
      }
    case "session_read":
      return {
        icon: "message-square",
        title: "Read Session",
        subtitle: input.target,
      }
    case "session_search":
      return {
        icon: "quote",
        title: "Search Sessions",
        subtitle: input.pattern,
      }
    case "session_send":
      return {
        icon: "share",
        title: "Send Message",
        subtitle: input.target,
      }
    case "profile_get":
      return {
        icon: "user",
        title: "Profile",
        subtitle: input.name,
      }
    case "profile_update":
      return {
        icon: "user",
        title: "Update Profile",
        subtitle: input.name,
      }
    case "agenda_create":
      return {
        icon: "calendar-days",
        title: "Create Agenda",
        subtitle: input.title,
      }
    case "agenda_list":
      return {
        icon: "clipboard-list",
        title: "Agenda",
        subtitle: input.status,
      }
    case "agenda_update":
      return {
        icon: "refresh-ccw",
        title: "Update Agenda",
        subtitle: input.id,
      }
    case "agenda_delete":
      return {
        icon: "trash-2",
        title: "Delete Agenda",
        subtitle: input.id,
      }
    case "agenda_trigger":
      return {
        icon: "zap",
        title: "Trigger Agenda",
        subtitle: input.id,
      }
    case "agenda_logs":
      return {
        icon: "clock",
        title: "Agenda Logs",
        subtitle: input.id,
      }
    case "agora_search":
      return {
        icon: "users",
        title: "Agora Search",
        subtitle: input.keyword,
      }
    case "agora_read":
      return {
        icon: "users",
        title: "Agora Read",
        subtitle: input.post_id,
      }
    case "agora_post":
      return {
        icon: "users",
        title: "Agora Post",
        subtitle: input.title,
      }
    case "agora_respond":
      return {
        icon: "users",
        title: "Agora Respond",
        subtitle: input.type,
      }
    case "agora_clone":
      return {
        icon: "git-branch",
        title: "Agora Clone",
        subtitle: input.answer_id,
      }
    case "agora_repo":
      return {
        icon: "folder",
        title: "Agora Repo",
        subtitle: input.post_id,
      }
    case "agora_git":
      return {
        icon: "git-branch",
        title: "Agora Git",
        subtitle: input.answer_id,
      }
    case "memory_search":
      return {
        icon: "brain",
        title: "Memory Search",
        subtitle: input.query,
      }
    case "memory_get":
      return {
        icon: "brain",
        title: "Memory Get",
      }
    case "memory_write":
      return {
        icon: "brain",
        title: "Memory Write",
        subtitle: input.title,
      }
    case "memory_edit":
      return {
        icon: "brain",
        title: "Memory Edit",
        subtitle: input.title,
      }
    case "email":
      return {
        icon: "mail",
        title: "Email",
        subtitle: input.to ? `To: ${Array.isArray(input.to) ? input.to.join(", ") : input.to}` : input.subject,
      }
    case "runtime_reload": {
      const target = Array.isArray(input.target)
        ? input.target.length <= 3
          ? input.target.join(", ")
          : `${input.target.length} targets`
        : input.target
      return {
        icon: "refresh-ccw",
        title: "Runtime Reload",
        subtitle: target || input.reason,
      }
    }
    case "connect":
      return {
        icon: "cable",
        title: "Connect",
        subtitle: input.envID,
      }
    default:
      return {
        icon: "settings",
        title: tool,
      }
  }
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => <UserMessageDisplay message={userMessage() as UserMessage} parts={props.parts} />}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay message={assistantMessage() as AssistantMessage} parts={props.parts} />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: { message: AssistantMessage; parts: PartType[] }) {
  const emptyParts: PartType[] = []
  const filteredParts = createMemo(
    () =>
      props.parts.filter((x) => {
        return x.type !== "tool" || ((x as ToolPart).tool !== "todoread" && (x as ToolPart).tool !== "dagread")
      }),
    emptyParts,
    { equals: same },
  )
  return <For each={filteredParts()}>{(part) => <Part part={part} message={props.message} />}</For>
}

export function UserMessageDisplay(props: { message: UserMessage; parts: PartType[] }) {
  const dialog = useDialog()

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const isNoteAttachment = (file: FilePart) => file.metadata?.kind === "note"
  const isSessionAttachment = (file: FilePart) => file.metadata?.kind === "session"

  const noteAttachments = createMemo(() => files().filter(isNoteAttachment))
  const sessionAttachments = createMemo(() => files().filter(isSessionAttachment))

  const attachments = createMemo(() =>
    files().filter((f) => {
      if (isNoteAttachment(f) || isSessionAttachment(f)) return false
      const mime = f.mime
      return (
        mime.startsWith("image/") ||
        mime === "application/pdf" ||
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      )
    }),
  )

  const inlineFiles = createMemo(() =>
    files().filter((f) => {
      if (isNoteAttachment(f) || isSessionAttachment(f)) return false
      const mime = f.mime
      return !mime.startsWith("image/") && mime !== "application/pdf" && f.source?.text?.start !== undefined
    }),
  )

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  return (
    <div data-component="user-message">
      <Show when={attachments().length > 0 || noteAttachments().length > 0 || sessionAttachments().length > 0}>
        <div data-slot="user-message-attachments">
          <For each={attachments()}>
            {(file) => (
              <div
                data-slot="user-message-attachment"
                data-type={file.mime.startsWith("image/") ? "image" : "file"}
                data-clickable={file.mime.startsWith("image/") && !!file.url}
                onClick={() => {
                  if (file.mime.startsWith("image/") && file.url) {
                    openImagePreview(file.url, file.filename)
                  }
                }}
              >
                <Show
                  when={file.mime.startsWith("image/") && file.url}
                  fallback={
                    <div data-slot="user-message-attachment-file">
                      <FileIcon
                        node={{ path: file.filename ?? "file", type: "file" }}
                        data-slot="user-message-attachment-file-icon"
                      />
                      <span data-slot="user-message-attachment-filename">{file.filename ?? "file"}</span>
                    </div>
                  }
                >
                  <img data-slot="user-message-attachment-image" src={file.url} alt={file.filename ?? "attachment"} />
                </Show>
              </div>
            )}
          </For>
          <For each={noteAttachments()}>
            {(file) => (
              <div data-slot="user-message-attachment" data-type="note">
                <div data-slot="user-message-note-attachment">
                  <Icon name="notebook-pen" data-slot="user-message-note-icon" />
                  <div data-slot="user-message-note-copy">
                    <span data-slot="user-message-note-title">
                      {(file.metadata?.title as string | undefined) || file.filename || "Untitled"}
                    </span>
                    <span data-slot="user-message-note-subtitle">Note</span>
                  </div>
                </div>
              </div>
            )}
          </For>
          <For each={sessionAttachments()}>
            {(file) => (
              <div data-slot="user-message-attachment" data-type="session">
                <div data-slot="user-message-note-attachment">
                  <Icon name="message-square" data-slot="user-message-note-icon" />
                  <div data-slot="user-message-note-copy">
                    <span data-slot="user-message-note-title">
                      {(file.metadata?.title as string | undefined) || file.filename || "Untitled"}
                    </span>
                    <span data-slot="user-message-note-subtitle">Session</span>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={text()}>
        <div data-slot="user-message-text">
          <HighlightedText text={text()} references={inlineFiles()} />
        </div>
      </Show>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" }

function HighlightedText(props: { text: string; references: FilePart[] }) {
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return (
    <For each={segments()}>
      {(segment) => (
        <span
          classList={{
            "text-syntax-property": segment.type === "file",
          }}
        >
          {segment.text}
        </span>
      )}
    </For>
  )
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

function joinServerUrl(serverUrl: string, pathname: string): string {
  return `${serverUrl.replace(/\/$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`
}

function resolvePartUrl(serverUrl: string, url: string): string {
  if (url.startsWith("asset://")) return joinServerUrl(serverUrl, `/asset/${url.slice(8)}`)
  return url
}

function ToolAttachments(props: { attachments: FilePart[] }) {
  const data = useData()
  return (
    <div data-component="tool-attachments">
      <For each={props.attachments}>
        {(file) => (
          <a
            data-component="tool-attachment"
            href={resolvePartUrl(data.serverUrl, file.url)}
            download={file.filename ?? "file"}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FileIcon node={{ path: file.filename ?? "file", type: "file" }} />
            <span data-slot="tool-attachment-filename">{file.filename ?? "file"}</span>
            <Icon name="download" size="small" />
          </a>
        )}
      </For>
    </div>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const part = props.part as ToolPart

  const permission = createMemo(() => {
    const next = data.store.permission?.[props.message.sessionID]?.[0]
    if (!next || !next.tool) return undefined
    if (next.tool!.callID !== part.callID) return undefined
    return next
  })

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const throttledRaw = createThrottledValue(() =>
    part.state.status === "pending" ? ((part.state as any).raw ?? "") : "",
  )
  const [streamInput, setStreamInput] = createStore<Record<string, any>>({})
  createEffect(() => {
    const raw = throttledRaw()
    if (raw) {
      const parsed = parsePartialJson(raw)
      setStreamInput(reconcile(parsed))
    }
  })
  const input = () => {
    const raw = throttledRaw()
    if (raw) return streamInput
    return part.state?.input ?? emptyInput
  }
  // @ts-expect-error
  const metadata = () => part.state?.metadata ?? emptyMetadata

  const render = ToolRegistry.render(part.tool) ?? GenericTool

  return (
    <div data-component="tool-part-wrapper" data-permission={!!permission()}>
      <Switch>
        <Match when={part.state.status === "error" && part.state.error}>
          {(error) => {
            const cleaned = error().replace("Error: ", "")
            const [title, ...rest] = cleaned.split(": ")
            return (
              <Card variant="error">
                <div data-component="tool-error">
                  <Icon name="ban" size="small" />
                  <Switch>
                    <Match when={title && title.length < 30}>
                      <div data-slot="message-part-tool-error-content">
                        <div data-slot="message-part-tool-error-title">{title}</div>
                        <span data-slot="message-part-tool-error-message">{rest.join(": ")}</span>
                      </div>
                    </Match>
                    <Match when={true}>
                      <span data-slot="message-part-tool-error-message">{cleaned}</span>
                    </Match>
                  </Switch>
                </div>
              </Card>
            )
          }}
        </Match>
        <Match when={true}>
          <Dynamic
            component={render}
            input={input()}
            tool={part.tool}
            metadata={metadata()}
            // @ts-expect-error
            output={part.state.output}
            status={part.state.status}
            hideDetails={props.hideDetails}
            defaultOpen={props.defaultOpen}
          />
        </Match>
      </Switch>
      <Show
        when={
          part.tool !== "attach" &&
          part.state.status === "completed" &&
          (part.state as ToolStateCompleted).attachments?.length
        }
      >
        <ToolAttachments attachments={(part.state as ToolStateCompleted).attachments!} />
      </Show>
    </div>
  )
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const part = props.part as TextPart
  const displayText = () => relativizeProjectPaths((part.text ?? "").trim(), data.directory)

  const sessionStatus = () => data.store.session_status[props.message.sessionID]
  const isStreaming = () => sessionStatus()?.type === "busy"

  const typedText = createTypewriter({
    source: displayText,
    streaming: isStreaming,
  })

  return (
    <Show when={typedText()}>
      <div data-component="text-part">
        <Markdown text={typedText()} cacheKey={part.id} />
      </div>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const part = props.part as ReasoningPart
  const text = () => part.text.trim()

  const sessionStatus = () => data.store.session_status[props.message.sessionID]
  const isStreaming = () => sessionStatus()?.type === "busy"

  const typedText = createTypewriter({
    source: text,
    streaming: isStreaming,
  })

  return (
    <Show when={typedText()}>
      <div data-component="reasoning-part">
        <Markdown text={typedText()} cacheKey={part.id} />
      </div>
    </Show>
  )
}
