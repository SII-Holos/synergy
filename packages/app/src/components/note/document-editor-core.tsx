import { createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import { Table } from "@tiptap/extension-table"
import { TableRow } from "@tiptap/extension-table-row"
import { TableHeader } from "@tiptap/extension-table-header"
import { TableCell } from "@tiptap/extension-table-cell"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import CodeBlockShiki from "tiptap-extension-code-block-shiki"
import MathExtension from "@aarkue/tiptap-math-extension"

import { useLingui } from "@lingui/solid"
import { docEditor as D } from "@/locales/messages"
import { Video, Mermaid, CrossCellSelection, createFileUpload } from "@/components/note/extensions"
import { createSlashCommands } from "@/components/note/slash-menu"
import { createBubbleMenu, BubbleMenuContent } from "@/components/note/bubble-menu"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { registerSynergyShikiThemes, SYNERGY_SHIKI_DARK, SYNERGY_SHIKI_LIGHT } from "./shiki-theme"

registerSynergyShikiThemes()

// ---------------------------------------------------------------------------
// Shared Tiptap styles — used by NoteEditor and future BlueprintEditor
// ---------------------------------------------------------------------------

export const TIPTAP_STYLES = `
  .tiptap {
    outline: none;
    min-height: 100%;
    font-family: ui-sans-serif, system-ui, sans-serif;
    color: var(--text-base);
  }
  .tiptap::after {
    content: '';
    display: block;
    height: 50vh;
  }
  .tiptap p {
    margin-bottom: 0.75em;
    line-height: 1.6;
    font-size: 0.9375rem;
    color: var(--text-base);
  }
  .tiptap h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    color: var(--text-strong);
  }
  .tiptap h2 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-top: 1.25em;
    margin-bottom: 0.5em;
    color: var(--text-strong);
  }
  .tiptap h3 {
    font-size: 1.125rem;
    font-weight: 600;
    margin-top: 1em;
    margin-bottom: 0.5em;
    color: var(--text-strong);
  }
  .tiptap ul, .tiptap ol {
    padding-left: 1.5em;
    margin-bottom: 0.75em;
    color: var(--text-base);
  }
  .tiptap ul { list-style-type: disc; }
  .tiptap ol { list-style-type: decimal; }
  .tiptap blockquote {
    margin-left: 0;
    margin-right: 0;
    margin-bottom: 0.95em;
    border-left: 3px solid color-mix(in srgb, var(--border-strong-base) 78%, var(--surface-brand-base));
    border-radius: 0 0.9rem 0.9rem 0;
    background: color-mix(in srgb, var(--surface-inset-base) 74%, transparent);
    padding: 0.9em 1.05em;
    font-style: italic;
    color: var(--text-weak);
    box-shadow: inset 0 1px 0 var(--border-weak-base);
  }
  .tiptap pre {
    background: var(--surface-inset-base);
    border: 1px solid color-mix(in srgb, var(--border-base) 72%, transparent);
    border-radius: 0.95rem;
    padding: 1em 1.05em;
    overflow-x: auto;
    margin-bottom: 0.95em;
    box-shadow: inset 0 1px 0 var(--border-weak-base), 0 14px 34px -28px var(--surface-overlay);
  }
  .tiptap pre.shiki,
  .tiptap pre.shiki code,
  .tiptap pre.shiki span {
    background-color: var(--shiki-light-bg, var(--surface-inset-base)) !important;
  }
  [data-color-scheme="dark"] .tiptap pre.shiki,
  [data-color-scheme="dark"] .tiptap pre.shiki code,
  [data-color-scheme="dark"] .tiptap pre.shiki span {
    color: var(--shiki-dark, var(--text-base)) !important;
    background-color: var(--shiki-dark-bg, var(--surface-inset-base)) !important;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-color-scheme]) .tiptap pre.shiki,
    :root:not([data-color-scheme]) .tiptap pre.shiki code,
    :root:not([data-color-scheme]) .tiptap pre.shiki span {
      color: var(--shiki-dark, var(--text-base)) !important;
      background-color: var(--shiki-dark-bg, var(--surface-inset-base)) !important;
    }
  }
  .tiptap pre code {
    background: none;
    padding: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.875rem;
    color: var(--text-strong);
  }
  .tiptap code {
    background: color-mix(in srgb, var(--surface-inset-base) 78%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-base) 58%, transparent);
    padding: 0.18em 0.45em;
    border-radius: 0.45rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.85em;
    color: var(--text-strong);
    box-shadow: inset 0 1px 0 var(--border-weak-base);
  }
  .tiptap table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 0.95em;
    overflow: hidden;
    border-radius: 0.95rem;
  }
  .tiptap td, .tiptap th {
    border: 1px solid color-mix(in srgb, var(--border-weak-base) 82%, transparent);
    padding: 0.6em 0.7em;
    text-align: left;
  }
  .tiptap th {
    background: color-mix(in srgb, var(--surface-inset-base) 72%, transparent);
    font-weight: 600;
  }
  .tiptap p.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    float: left;
    color: var(--text-weaker);
    pointer-events: none;
    height: 0;
  }
  .tiptap ul[data-type="taskList"] {
    list-style: none;
    padding: 0;
  }
  .tiptap ul[data-type="taskList"] li {
    display: flex;
    gap: 0.5em;
    align-items: flex-start;
  }
  .tiptap ul[data-type="taskList"] li input[type="checkbox"] {
    margin-top: 0.3em;
  }
  .tiptap a {
    color: var(--text-interactive-base);
    text-decoration: none;
    text-decoration-color: color-mix(in srgb, var(--text-interactive-base) 38%, transparent);
  }
  .tiptap a:hover {
    text-decoration: underline;
  }
  .katex-display {
    margin: 0.5em 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .tiptap video {
    max-width: 100%;
    border-radius: 0.5rem;
    margin-bottom: 0.75em;
  }
  .tiptap .mermaid-node {
    margin-bottom: 0.75em;
  }
  .note-bubble-menu {
    z-index: 100;
  }
  .note-preview-content p,
  .note-preview-content ul,
  .note-preview-content ol,
  .note-preview-content blockquote,
  .note-preview-content pre {
    margin-bottom: 0.4em;
  }
  .note-preview-content ul,
  .note-preview-content ol {
    padding-left: 1.2em;
  }
  .note-preview-content ul { list-style-type: disc; }
  .note-preview-content ol { list-style-type: decimal; }
  .note-preview-content h1,
  .note-preview-content h2,
  .note-preview-content h3 {
    font-weight: 500;
    margin-bottom: 0.25em;
    color: var(--text-weak);
  }
  .note-preview-content h1 { font-size: 0.72rem; }
  .note-preview-content h2 { font-size: 0.7rem; }
  .note-preview-content h3 { font-size: 0.68rem; }
  .note-preview-content code {
    background: color-mix(in srgb, var(--surface-inset-base) 78%, transparent);
    border-radius: 0.3rem;
    padding: 0.05em 0.3em;
    font-size: 0.85em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .note-preview-content pre {
    background: var(--surface-inset-base);
    border-radius: 0.5rem;
    padding: 0.5em 0.65em;
    overflow-x: auto;
    font-size: 0.8em;
  }
  .note-preview-content pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }
  .note-preview-content blockquote {
    border-left: 2px solid color-mix(in srgb, var(--border-weak-base) 80%, transparent);
    padding-left: 0.6em;
    color: var(--text-weaker);
  }
  .note-preview-content hr {
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--border-weaker-base) 76%, transparent);
    margin: 0.5em 0;
  }
  .note-preview-content .note-preview-link {
    color: var(--text-interactive-base);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--text-interactive-base) 34%, transparent);
    text-underline-offset: 0.15em;
  }
  .note-preview-content .note-preview-math {
    display: inline-flex;
    max-width: 100%;
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--surface-inset-base) 76%, transparent);
    padding: 0.05em 0.32em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.82em;
    color: var(--text-weak);
    vertical-align: baseline;
  }
  .note-preview-content .note-preview-math--display {
    display: flex;
    width: 100%;
    overflow: hidden;
    white-space: nowrap;
  }
  .note-preview-content .note-preview-figure {
    margin: 0.15em 0 0.55em;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--border-weaker-base) 80%, transparent);
    border-radius: 0.65rem;
    background: var(--surface-inset-base);
  }
  .note-preview-content .note-preview-figure img {
    display: block;
    width: 100%;
    max-height: 5.75rem;
    object-fit: cover;
  }
  .note-preview-content .note-preview-figure figcaption {
    overflow: hidden;
    padding: 0.32rem 0.48rem;
    color: var(--text-weaker);
    font-size: 0.75em;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-preview-content .note-preview-image-inline {
    display: inline-flex;
    max-width: min(8rem, 100%);
    overflow: hidden;
    border-radius: 0.4rem;
    vertical-align: middle;
  }
  .note-preview-content .note-preview-image-inline img {
    display: block;
    max-width: 100%;
    max-height: 2.6rem;
    object-fit: cover;
  }
  .note-preview-content .note-preview-media-placeholder,
  .note-preview-content .note-preview-diagram {
    display: flex;
    min-height: 2.25rem;
    align-items: center;
    gap: 0.45rem;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--border-weaker-base) 78%, transparent);
    border-radius: 0.6rem;
    background: color-mix(in srgb, var(--surface-inset-base) 72%, transparent);
    padding: 0.45rem 0.55rem;
    margin-bottom: 0.45em;
    color: var(--text-weak);
  }
  .note-preview-content .note-preview-media-placeholder span,
  .note-preview-content .note-preview-diagram span {
    flex-shrink: 0;
    font-size: 0.78em;
    font-weight: 600;
  }
  .note-preview-content .note-preview-media-placeholder small,
  .note-preview-content .note-preview-diagram code {
    min-width: 0;
    overflow: hidden;
    color: var(--text-weaker);
    font-size: 0.76em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-preview-content .note-preview-table-wrap {
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--border-weaker-base) 80%, transparent);
    border-radius: 0.6rem;
    margin-bottom: 0.5em;
    background: color-mix(in srgb, var(--surface-raised-base) 76%, var(--surface-inset-base));
  }
  .note-preview-content .note-preview-table-wrap table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .note-preview-content .note-preview-table-wrap th,
  .note-preview-content .note-preview-table-wrap td {
    overflow: hidden;
    border-bottom: 1px solid color-mix(in srgb, var(--border-weaker-base) 70%, transparent);
    border-right: 1px solid color-mix(in srgb, var(--border-weaker-base) 60%, transparent);
    padding: 0.34rem 0.42rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-preview-content .note-preview-table-wrap th {
    background: color-mix(in srgb, var(--surface-inset-base) 74%, transparent);
    color: var(--text-weak);
    font-weight: 600;
  }
  .note-preview-content .note-preview-table-wrap tr:last-child td {
    border-bottom: 0;
  }
  .note-preview-content .note-preview-table-wrap th:last-child,
  .note-preview-content .note-preview-table-wrap td:last-child {
    border-right: 0;
  }
  .note-preview-content .note-preview-table-more {
    padding: 0.28rem 0.45rem;
    color: var(--text-weaker);
    font-size: 0.72em;
    line-height: 1.2;
  }
  .note-preview-content .note-preview-media-chip {
    display: inline-flex;
    align-items: center;
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--surface-inset-base) 72%, transparent);
    padding: 0.08em 0.35em;
    color: var(--text-weaker);
    font-size: 0.82em;
  }
  .note-preview-content .note-preview-task-list {
    list-style: none;
    padding-left: 0;
  }
  .note-preview-content .note-preview-task-list li {
    display: flex;
    gap: 0.4em;
    align-items: flex-start;
  }
  .note-preview-content .note-preview-task-list input[type="checkbox"] {
    margin-top: 0.2em;
  }
  .note-preview-content strong {
    font-weight: 600;
  }
  .note-preview-content em {
    font-style: italic;
  }
  .note-preview-content s {
    text-decoration: line-through;
  }
`

// ---------------------------------------------------------------------------
// Shared extension factory — one source of truth for the Tiptap extension list
// ---------------------------------------------------------------------------

export { BubbleMenuContent } from "@/components/note/bubble-menu"

export interface DocumentEditorExtensionsConfig {
  /** Synergy SDK client for file upload extension. */
  sdkClient: SynergyClient
  /** Server base URL for asset URLs. */
  sdkUrl: string
  /** File upload handler for slash-command image/file insertion. */
  onUploadFile: (file: File) => Promise<string>
  /** Ref to the bubble menu container element. */
  bubbleRef: HTMLDivElement
  /** Lingui i18n context for localized command titles. */
  lingui: ReturnType<typeof useLingui>
}

export function createDocumentEditorExtensions(config: DocumentEditorExtensionsConfig) {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: false,
    }),
    Placeholder.configure({
      placeholder: config.lingui._({ id: D.slashHint.id, message: D.slashHint.message }),
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
    }),
    Image,
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    CrossCellSelection,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    CodeBlockShiki.configure({
      defaultTheme: SYNERGY_SHIKI_LIGHT,
      themes: {
        light: SYNERGY_SHIKI_LIGHT,
        dark: SYNERGY_SHIKI_DARK,
      },
    }),
    MathExtension,
    Video,
    Mermaid,
    createFileUpload(config.sdkClient, config.sdkUrl),
    createSlashCommands({ onUploadFile: config.onUploadFile, lingui: config.lingui }),
    createBubbleMenu(config.bubbleRef),
  ]
}

// ---------------------------------------------------------------------------
// DocumentEditorCore — shared Tiptap shell (editor area + bubble menu + save
// indicator). Parent owns data-loading, autosave, conflict, toolbar, and tags.
// ---------------------------------------------------------------------------

export interface DocumentEditorCoreProps {
  /** Initial ProseMirror content (JSON). Used only on first mount. */
  content: unknown
  /** Called on every editor content update so the parent can mark dirty & schedule save. */
  onUpdate: () => void
  /** Called when the editor instance is ready, passing it so the parent can read/write content. */
  onEditorReady: (editor: Editor) => void
  /** File upload function for slash-command image insertion. */
  uploadFile: (file: File) => Promise<string>
  /** Synergy SDK client. */
  sdkClient: SynergyClient
  /** Server base URL. */
  sdkUrl: string
  /** Whether the document is currently saving (visual indicator text). */
  saving: boolean
}

/**
 * Shared Tiptap editor core: extensions, editor lifecycle, editor area DOM,
 * bubble menu, and save indicator.
 *
 * Mount this component inside a {@link Show when={loaded}} guard — it creates
 * the editor on mount and destroys it on cleanup.
 *
 * Consumers (NoteEditor, future BlueprintEditor) own their own data-loading,
 * autosave/conflict, toolbar, tags, and metadata logic.
 */
export function DocumentEditorCore(props: DocumentEditorCoreProps) {
  const lingui = useLingui()
  let editorRef!: HTMLDivElement
  let bubbleRef!: HTMLDivElement
  const [editorInstance, setEditorInstance] = createSignal<Editor>()

  onMount(() => {
    const instance = new Editor({
      element: editorRef,
      extensions: createDocumentEditorExtensions({
        sdkClient: props.sdkClient,
        sdkUrl: props.sdkUrl,
        onUploadFile: props.uploadFile,
        bubbleRef,
        lingui,
      }),
      content: untrack(() => props.content) as any,
      onUpdate: ({ editor }) => {
        if (editor.isDestroyed) return
        props.onUpdate()
      },
    })

    setEditorInstance(instance)
    props.onEditorReady(instance)

    onCleanup(() => instance.destroy())
  })

  function handleEditorAreaClick(e: MouseEvent) {
    const ed = editorInstance()
    if (!ed || ed.isDestroyed || ed.isFocused) return
    const target = e.target as HTMLElement
    if (target === editorRef) {
      ed.commands.focus()
      return
    }
    if (!target.classList.contains("tiptap")) return
    const pos = ed.view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (pos) {
      ed.commands.focus()
      ed.commands.setTextSelection(pos.pos)
    }
  }

  return (
    <div class="document-editor-core relative flex-1 min-h-0 bg-surface-raised-base">
      <div class="relative h-full overflow-hidden">
        <div
          ref={editorRef}
          class="h-full overflow-y-auto px-7 py-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onClick={handleEditorAreaClick}
        />
        <div
          class="pointer-events-none absolute inset-x-0 bottom-0 h-14"
          style={{ background: "linear-gradient(to top, var(--surface-raised-base), transparent)" }}
        />
      </div>
      <div ref={bubbleRef} class="note-bubble-menu">
        <Show when={editorInstance()} keyed>
          {(editor) => <BubbleMenuContent editor={editor} />}
        </Show>
      </div>
      <div class="pointer-events-none absolute bottom-4 right-4 inline-flex items-center rounded-full bg-background-base/72 px-3 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-weak-base backdrop-blur-sm">
        <Show when={props.saving} fallback="Saved">
          {lingui._({ id: D.saving.id, message: D.saving.message })}
        </Show>
      </div>
    </div>
  )
}
