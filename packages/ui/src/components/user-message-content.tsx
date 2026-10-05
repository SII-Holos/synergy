import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { AttachmentPart, Part as PartType, TextPart, UserMessage } from "@ericsanchezok/synergy-sdk"
import { useData } from "../context"
import { useResourceOpen } from "../context/resource-open"
import { AttachmentGallery, type AttachmentFile } from "./attachment-card"
import { createCopyController } from "./clipboard"
import { Icon } from "./icon"
import { getSemanticIcon } from "./semantic-icon"
import { Tooltip } from "./tooltip"
import { UserMarkdown } from "./user-markdown"
import { MESSAGE_PART_DESC } from "./tool-title-descriptors"
import { shouldCollapseUserMessage, visibleUserMessageText } from "./user-message-utils"

export type UserMessageVariant = "default" | "turn-bubble"

const SEARCH_REFLECTION_MARKER = "[Search failure reflection]"
const SEARCH_EARLY_STOP_MARKER = "[Search early stop]"

type SearchReflectionNoticeData = {
  id: string
  kind: "reflection" | "early-stop"
  titleDescriptor: MessageDescriptor
  text: string
}

function parseSearchReflectionNotice(part: TextPart): SearchReflectionNoticeData | undefined {
  if (!part.synthetic) return undefined

  const kind = part.text.includes(SEARCH_EARLY_STOP_MARKER)
    ? "early-stop"
    : part.text.includes(SEARCH_REFLECTION_MARKER)
      ? "reflection"
      : undefined
  if (!kind) return undefined

  return {
    id: part.id,
    kind,
    titleDescriptor: kind === "early-stop" ? MESSAGE_PART_DESC.searchEarlyStop : MESSAGE_PART_DESC.searchReflection,
    text: part.text,
  }
}

function SearchReflectionNoticeView(props: { notice: SearchReflectionNoticeData }) {
  const { _ } = useLingui()
  const title = () =>
    props.notice.kind === "early-stop" ? _(MESSAGE_PART_DESC.searchEarlyStop) : _(MESSAGE_PART_DESC.searchReflection)
  return (
    <div data-slot="user-message-search-reflection" data-kind={props.notice.kind}>
      <div data-slot="user-message-search-reflection-header">
        <Icon name={getSemanticIcon("action.search")} size="small" />
        <span>{title()}</span>
      </div>
      <div data-slot="user-message-search-reflection-body">{props.notice.text}</div>
    </div>
  )
}

function formatMessageTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, "0")
  const minutes = date.getMinutes().toString().padStart(2, "0")
  return `${hours}:${minutes}`
}

export type UserMessageFile = Omit<AttachmentFile, "source"> & { source?: AttachmentPart["source"] }

export function createUserMessagePresentation() {
  const [expanded, setExpanded] = createSignal(false)
  const [sourceView, setSourceView] = createSignal(false)
  const [attachmentsExpanded, setAttachmentsExpanded] = createSignal(false)
  return { expanded, setExpanded, sourceView, setSourceView, attachmentsExpanded, setAttachmentsExpanded }
}
export type UserMessagePresentation = ReturnType<typeof createUserMessagePresentation>

export function UserMessageDisplay(props: {
  message: UserMessage
  parts: PartType[]
  variant?: UserMessageVariant
  loadCopyText?: () => Promise<string>
  showMetadata?: boolean
  hasText?: boolean
  presentation?: UserMessagePresentation
}) {
  const data = useData()
  return (
    <UserMessageContent
      text={visibleUserMessageText(props.parts)}
      files={props.parts.filter((part): part is AttachmentPart => part.type === "attachment")}
      notices={props.parts
        .filter((part): part is TextPart => part.type === "text")
        .map(parseSearchReflectionNotice)
        .filter((notice): notice is SearchReflectionNoticeData => !!notice)}
      serverUrl={data.serverUrl}
      created={props.message.time?.created}
      variant={props.variant}
      loadCopyText={props.loadCopyText}
      showMetadata={props.showMetadata}
      hasText={props.hasText}
      presentation={props.presentation}
    />
  )
}

export function UserMessageContent(props: {
  text: string
  files: readonly UserMessageFile[]
  notices?: SearchReflectionNoticeData[]
  serverUrl: string
  created?: number
  variant?: UserMessageVariant
  loadCopyText?: () => Promise<string>
  showMetadata?: boolean
  hasText?: boolean
  presentation?: UserMessagePresentation
  onAttachmentOpen?: (file: AttachmentFile) => void
}) {
  const { _ } = useLingui()
  const internalPresentation = createUserMessagePresentation()
  const presentation = () => props.presentation ?? internalPresentation
  const expanded = () => presentation().expanded()
  const setExpanded = (value: boolean) => presentation().setExpanded(value)
  const sourceView = () => presentation().sourceView()
  const setSourceView = (value: boolean) => presentation().setSourceView(value)
  const [renderedHeight, setRenderedHeight] = createSignal(0)
  const resourceOpen = useResourceOpen()
  const [messageBody, setMessageBody] = createSignal<HTMLDivElement>()
  createEffect(() => {
    const element = messageBody()
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setRenderedHeight(element.scrollHeight))
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  const text = () => props.text
  const isTurnBubble = createMemo(() => props.variant === "turn-bubble")
  const canCollapse = createMemo(() => isTurnBubble() && (shouldCollapseUserMessage(text()) || renderedHeight() > 320))
  const collapsed = createMemo(() => canCollapse() && !expanded())
  const timestamp = createMemo(() => {
    const created = props.created
    return typeof created === "number" ? formatMessageTimestamp(created) : undefined
  })

  const searchReflections = () => props.notices ?? []
  const files = () => props.files
  const isNoteAttachment = (file: UserMessageFile) => file.metadata?.kind === "note"
  const isSessionAttachment = (file: UserMessageFile) => file.metadata?.kind === "session"

  const noteAttachments = createMemo(() => files().filter(isNoteAttachment))
  const sessionAttachments = createMemo(() => files().filter(isSessionAttachment))

  const attachments = createMemo(() =>
    files().filter((f) => {
      if (isNoteAttachment(f) || isSessionAttachment(f)) return false
      if (f.source?.text?.start !== undefined) return false
      return true
    }),
  )

  const hasVisibleContent = () => !!text() || files().length > 0
  const hasText = () => props.hasText ?? !!text()
  const inlineFiles = createMemo(() =>
    files().filter((f) => {
      if (isNoteAttachment(f) || isSessionAttachment(f)) return false
      return f.source?.text?.start !== undefined
    }),
  )

  const copy = createCopyController({
    text,
    loadText: props.loadCopyText,
    copyLabel: _(MESSAGE_PART_DESC.copyMessage),
    copiedLabel: _(MESSAGE_PART_DESC.messageCopied),
    failureDescription: _(MESSAGE_PART_DESC.copyFailure),
  })

  return (
    <div data-component="user-message" data-variant={props.variant ?? "default"}>
      <Show when={attachments().length > 0 || noteAttachments().length > 0 || sessionAttachments().length > 0}>
        <div data-slot="user-message-attachments">
          <AttachmentGallery
            files={attachments()}
            serverUrl={props.serverUrl}
            onOpen={props.onAttachmentOpen}
            expanded={presentation().attachmentsExpanded()}
            onExpandedChange={presentation().setAttachmentsExpanded}
            align="end"
            layout="rows"
            compact="user"
          />
          <For each={noteAttachments()}>{(file) => <SpecialFileAttachment file={file} kind="note" />}</For>
          <For each={sessionAttachments()}>{(file) => <SpecialFileAttachment file={file} kind="session" />}</For>
        </div>
      </Show>
      <Show when={text()}>
        <div
          data-slot="user-message-text"
          data-collapsed={collapsed() ? "" : undefined}
          data-collapsible={canCollapse() ? "" : undefined}
        >
          <div ref={setMessageBody}>
            <Show when={!sourceView()} fallback={<HighlightedText text={text()} references={inlineFiles()} />}>
              <UserMarkdown
                text={text()}
                references={inlineFiles().map((file) => ({
                  start: file.source!.text!.start,
                  end: file.source!.text!.end,
                }))}
                onOpenReference={(index) => {
                  const file = inlineFiles()[index]
                  if (file)
                    resourceOpen?.open(
                      {
                        kind: "workspace-file",
                        path: fileReferencePath(file),
                        mime: file.mime,
                        filename: file.filename,
                      },
                      { prefer: "workspace" },
                    )
                }}
              />
            </Show>
          </div>
          <Show when={collapsed()}>
            <div data-slot="user-message-fade">
              <button type="button" data-slot="user-message-expand" onClick={() => setExpanded(true)}>
                {_(MESSAGE_PART_DESC.showMore)}
              </button>
            </div>
          </Show>
          <For each={searchReflections()}>{(notice) => <SearchReflectionNoticeView notice={notice} />}</For>
          <Show when={canCollapse() && expanded()}>
            <button
              type="button"
              data-slot="user-message-expand"
              data-position="inline"
              onClick={() => setExpanded(false)}
            >
              {_(MESSAGE_PART_DESC.showLess)}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.showMetadata !== false && hasVisibleContent()}>
        <div data-slot="user-message-meta">
          <Show when={hasText()}>
            <button
              type="button"
              data-slot="user-message-source"
              aria-pressed={sourceView()}
              onClick={() => setSourceView(!sourceView())}
            >
              {sourceView()
                ? _({ id: "ui.userMessage.markdown", message: "Markdown" })
                : _({ id: "ui.userMessage.source", message: "View source" })}
            </button>
          </Show>
          <Show keyed when={timestamp()}>
            {(value) => <span data-slot="user-message-time">{value}</span>}
          </Show>
          <Show when={hasText()}>
            <Tooltip value={copy.tooltip()} placement="top" gutter={4} class="user-message-copy-trigger">
              <button
                type="button"
                data-slot="user-message-copy"
                data-copy-state={copy.state()}
                aria-label={copy.tooltip()}
                disabled={copy.disabled()}
                onClick={() => void copy.copy()}
              >
                <Icon name={copy.copied() ? getSemanticIcon("state.success") : copy.icon()} size="small" />
              </button>
            </Tooltip>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export function SpecialFileAttachment(props: { file: UserMessageFile; kind: "note" | "session" }) {
  const { _ } = useLingui()
  const title = createMemo(
    () => (props.file.metadata?.title as string | undefined) || props.file.filename || _(MESSAGE_PART_DESC.untitled),
  )
  return (
    <div data-slot="user-message-attachment" data-type={props.kind}>
      <div data-slot="user-message-note-attachment">
        <Icon name={props.kind === "note" ? "notebook-pen" : "message-square"} data-slot="user-message-note-icon" />
        <div data-slot="user-message-note-copy">
          <span data-slot="user-message-note-title">{title()}</span>
          <span data-slot="user-message-note-subtitle">
            {props.kind === "note" ? _(MESSAGE_PART_DESC.noteLabel) : _(MESSAGE_PART_DESC.sessionLabel)}
          </span>
        </div>
      </div>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file"; file?: UserMessageFile }

function fileReferencePath(file: UserMessageFile) {
  const source = file.source as { path?: unknown } | undefined
  return typeof source?.path === "string" && source.path ? source.path : (file.url ?? "")
}

function HighlightedText(props: { text: string; references: UserMessageFile[] }) {
  const resourceOpen = useResourceOpen()
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file"; file: UserMessageFile }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({
          start: r.source!.text!.start,
          end: r.source!.text!.end,
          type: "file" as const,
          file: r,
        })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type, file: ref.file })
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
        <Show
          keyed
          when={resourceOpen ? segment.file : undefined}
          fallback={
            <span
              classList={{
                "text-syntax-property": segment.type === "file",
              }}
            >
              {segment.text}
            </span>
          }
        >
          {(file) => (
            <button
              type="button"
              class="inline text-left align-baseline text-syntax-property hover:underline decoration-dotted"
              onClick={() =>
                resourceOpen?.open(
                  {
                    kind: "workspace-file",
                    path: fileReferencePath(file),
                    mime: file.mime,
                    filename: file.filename,
                  },
                  { prefer: "workspace" },
                )
              }
            >
              {segment.text}
            </button>
          )}
        </Show>
      )}
    </For>
  )
}
