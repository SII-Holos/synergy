import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useLingui } from "@lingui/solid"
import { UserMarkdown } from "@ericsanchezok/synergy-ui/user-markdown"
import { useResourceOpen } from "@ericsanchezok/synergy-ui/context/resource-open"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { translateDescriptor } from "@/locales/translate"
import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { composerPresentation, formatComposerSelection, type ComposerFormat } from "./composer-presentation"

const formats = [
  { id: "heading", symbol: "H", label: { id: "prompt.long.heading", message: "Heading" } },
  { id: "bold", symbol: "B", label: { id: "prompt.long.bold", message: "Bold" } },
  { id: "italic", symbol: "I", label: { id: "prompt.long.italic", message: "Italic" } },
  { id: "strike", symbol: "S", label: { id: "prompt.long.strike", message: "Strikethrough" } },
  { id: "list", symbol: "≡", label: { id: "prompt.long.list", message: "List" } },
  { id: "quote", symbol: "❞", label: { id: "prompt.long.quote", message: "Quote" } },
  { id: "link", symbol: "↗", label: { id: "prompt.long.link", message: "Link" } },
  { id: "code", symbol: "{}", label: { id: "prompt.long.code", message: "Code" } },
] satisfies Array<{ id: ComposerFormat; symbol: string; label: { id: string; message: string } }>

export function ComposerLongEditor(props: {
  input: PluginInputService
  children: JSX.Element
  report(error: unknown): void
}) {
  const binding = composerPresentation(props.input)
  const { _, i18n } = useLingui()
  const resourceOpen = useResourceOpen()
  const [version, setVersion] = createSignal(0)
  if (binding) onCleanup(binding.state.subscribe(() => setVersion((value) => value + 1)))
  const expanded = () => {
    version()
    return binding?.state.expanded && props.input.current().mode === "normal"
  }
  const view = () => {
    version()
    return binding?.state.view ?? "edit"
  }
  const [preview, setPreview] = createSignal({
    text: "",
    references: [] as ReturnType<NonNullable<typeof binding>["preview"]>["references"],
  })
  createEffect(() => {
    props.input.current()
    if (!binding || !expanded() || props.input.composing()) return
    const value = binding.preview()
    const timer = setTimeout(() => setPreview(value), 150)
    onCleanup(() => clearTimeout(timer))
  })
  let root!: HTMLDivElement
  let savedRange: Range | undefined
  let savedScroll = 0
  const remember = () => {
    const editor = root.querySelector('[data-component="prompt-input"]')
    const selection = window.getSelection()
    if (editor && selection?.anchorNode && editor.contains(selection.anchorNode) && selection.rangeCount)
      savedRange = selection.getRangeAt(0).cloneRange()
    savedScroll = root.querySelector(".session-composer-editor")?.scrollTop ?? savedScroll
  }
  const restore = () => {
    const editor = root.querySelector<HTMLDivElement>('[data-component="prompt-input"]')
    editor?.focus({ preventScroll: true })
    if (savedRange?.startContainer.isConnected && savedRange.endContainer.isConnected) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(savedRange)
    }
    const scroller = root.querySelector(".session-composer-editor")
    if (scroller) scroller.scrollTop = savedScroll
  }
  const changeView = (value: "edit" | "preview") => {
    if (view() === "edit") remember()
    binding?.state.setView(value)
    if (value === "edit") queueMicrotask(restore)
  }
  const format = async (value: ComposerFormat) => {
    if (props.input.composing() || props.input.readOnly()) return
    restore()
    const current = props.input.current()
    await props.input.applyEdits({
      revision: current.revision,
      edits: [formatComposerSelection(current.text, current.selection, value)],
    })
    remember()
  }
  const references = createMemo(() => preview().references)
  return (
    <div
      class="composer-long-content"
      ref={root}
      data-expanded={expanded() ? "" : undefined}
      data-view={view()}
      onKeyDown={(event) => {
        if (
          !expanded() ||
          event.defaultPrevented ||
          (event.target instanceof Element && event.target.closest('[data-component="prompt-input"]'))
        )
          return
        if (event.key === "Escape") {
          event.preventDefault()
          binding?.state.collapse()
          queueMicrotask(restore)
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !props.input.composing()) {
          event.preventDefault()
          void props.input.submit().catch(props.report)
        }
      }}
    >
      <Show when={expanded()}>
        <div class="composer-long-tools">
          <div
            class="composer-long-views"
            role="group"
            aria-label={_({ id: "prompt.long.view", message: "Editor view" })}
          >
            <button
              type="button"
              aria-pressed={view() === "edit"}
              onPointerDown={remember}
              onClick={() => changeView("edit")}
            >
              {_({ id: "prompt.long.edit", message: "Edit" })}
            </button>
            <button
              type="button"
              aria-pressed={view() === "preview"}
              onPointerDown={remember}
              onClick={() => changeView("preview")}
            >
              {_({ id: "prompt.long.preview", message: "Preview" })}
            </button>
          </div>
          <Show when={view() === "edit"}>
            <div
              class="composer-long-format"
              role="group"
              aria-label={_({ id: "prompt.long.format", message: "Markdown formatting" })}
            >
              <For each={formats}>
                {(item) => (
                  <Tooltip value={translateDescriptor(item.label, i18n())}>
                    <button
                      type="button"
                      aria-label={translateDescriptor(item.label, i18n())}
                      disabled={props.input.composing() || props.input.readOnly()}
                      onPointerDown={(event) => {
                        remember()
                        event.preventDefault()
                      }}
                      onClick={() => void format(item.id).catch(props.report)}
                    >
                      {item.symbol}
                    </button>
                  </Tooltip>
                )}
              </For>
            </div>
          </Show>
          <span class="composer-long-shortcut">
            {_({ id: "prompt.long.shortcut", message: "Ctrl/⌘ + Enter to send" })}
          </span>
        </div>
      </Show>
      <div class="composer-long-panes">
        <div class="composer-long-source" inert={expanded() && view() === "preview"}>
          {props.children}
        </div>
        <Show when={expanded()}>
          <div
            class="composer-long-preview"
            tabIndex={0}
            aria-label={_({ id: "prompt.long.preview", message: "Preview" })}
          >
            <UserMarkdown
              text={preview().text}
              references={references()}
              onOpenReference={(index) => {
                const file = references()[index]
                if (file) resourceOpen?.open({ kind: "workspace-file", ...file }, { prefer: "workspace" })
              }}
            />
          </div>
        </Show>
      </div>
    </div>
  )
}

export function ComposerExpandButton(props: { input: PluginInputService }) {
  const binding = composerPresentation(props.input)
  const { _ } = useLingui()
  const [version, setVersion] = createSignal(0)
  if (binding) onCleanup(binding.state.subscribe(() => setVersion((value) => value + 1)))
  const expanded = () => {
    version()
    return !!binding?.state.expanded
  }
  return (
    <Show when={binding && props.input.current().mode === "normal"}>
      <Tooltip
        value={
          expanded()
            ? _({ id: "prompt.long.collapse", message: "Collapse editor" })
            : _({ id: "prompt.long.expand", message: "Expand editor" })
        }
      >
        <button
          type="button"
          class="composer-expand-control"
          aria-label={
            expanded()
              ? _({ id: "prompt.long.collapse", message: "Collapse editor" })
              : _({ id: "prompt.long.expand", message: "Expand editor" })
          }
          aria-expanded={expanded()}
          onClick={() => (expanded() ? binding?.state.collapse() : binding?.state.expand())}
        >
          <Icon name={getSemanticIcon(expanded() ? "window.restore" : "window.maximize")} size="small" />
        </button>
      </Tooltip>
    </Show>
  )
}
