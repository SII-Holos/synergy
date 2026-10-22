import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { useLocale } from "@/context/locale"
import {
  presentTextActions,
  textSelectionController,
  type TextAction,
  type TextSelectionAnchor,
  type TextSelectionSnapshot,
} from "@/context/text-selection"
import { quoteTarget } from "@/components/prompt-input/quote-target"
import { TS } from "./i18n"
import { placeTextActionSurface } from "./position"
import {
  SENSITIVE_SELECTION_SELECTOR,
  canQuoteSelection,
  opensOnSelection,
  selectionOrigin,
  selectionOwner,
  sensitiveSelection,
} from "./selection-dom"
import "./selection-toolbar.css"

type Invocation = { action: TextAction; snapshot: TextSelectionSnapshot; anchor: TextSelectionAnchor }

type State =
  | { kind: "menu"; snapshot: TextSelectionSnapshot; anchor: TextSelectionAnchor }
  | ({ kind: "loading" } & Invocation)
  | ({ kind: "result"; output: unknown } & Invocation)
  | ({ kind: "error"; message: string } & Invocation)

function quotedRole(snapshot: TextSelectionSnapshot) {
  if (snapshot.origin === "user_message") return "user" as const
  if (snapshot.origin === "assistant_message") return "assistant" as const
  return undefined
}

export function SelectionToolbar() {
  const { i18n } = useLocale()
  const [registryVersion, setRegistryVersion] = createSignal(0)
  const [state, setState] = createSignal<State>()
  const [position, setPosition] = createSignal({ x: 0, y: 0 })
  let surface: HTMLDivElement | undefined
  let invocation: AbortController | undefined

  const close = () => {
    invocation?.abort()
    invocation = undefined
    setState()
  }

  const open = (snapshot: TextSelectionSnapshot, anchor: TextSelectionAnchor) => {
    invocation?.abort()
    invocation = undefined
    setState({ kind: "menu", snapshot, anchor })
  }

  const trackSelection = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      textSelectionController.update(undefined)
      return
    }
    const range = selection.getRangeAt(0)
    const owner = selectionOwner(range.commonAncestorContainer)
    const rect = range.getBoundingClientRect()
    textSelectionController.update(selection.toString(), {
      excluded:
        !owner ||
        sensitiveSelection(selection.anchorNode) ||
        sensitiveSelection(selection.focusNode) ||
        !!range.cloneContents().querySelector(SENSITIVE_SELECTION_SELECTOR),
      source: "document",
      origin: selectionOrigin(owner, [selection.anchorNode, selection.focusNode]),
      editable: !!owner?.closest('input, textarea, [contenteditable="true"]'),
      wholeContainer: !!owner && selection.toString().trim() === (owner.textContent ?? "").trim(),
      owner: owner ?? undefined,
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    })
  }

  const copy = async (snapshot: TextSelectionSnapshot) => {
    const result = await copyTextToClipboard(snapshot.text, {
      label: i18n._(TS.copy),
      notifyFailure: false,
    })
    if (state()?.snapshot.selectionId !== snapshot.selectionId) return
    if (result.ok) {
      close()
      return
    }
    if (result.reason === "empty") return
    showToast({ type: "error", title: i18n._(TS.copyFailed) })
  }

  const addToChat = (snapshot: TextSelectionSnapshot) => {
    const target = quoteTarget()
    if (!target?.available()) return
    target.accept({ text: snapshot.text.trim(), role: quotedRole(snapshot) })
    close()
  }

  const run = async (input: Invocation) => {
    invocation?.abort()
    const controller = new AbortController()
    invocation = controller
    if (!input.action.presentation) {
      try {
        await textSelectionController.run(input.action.id, input.snapshot, controller.signal)
        if (!controller.signal.aborted) close()
      } catch (error) {
        if (controller.signal.aborted) return
        showToast({
          type: "error",
          title: i18n._(TS.failed),
          description: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    setState({ kind: "loading", ...input })
    try {
      const output = await textSelectionController.run(input.action.id, input.snapshot, controller.signal)
      if (!controller.signal.aborted) setState({ kind: "result", ...input, output })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({ kind: "error", ...input, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!state()) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (state()?.kind !== "menu") return
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const items = [...(surface?.querySelectorAll<HTMLButtonElement>("[data-action]") ?? [])]
    if (items.length === 0) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (index === -1) {
      items[event.key === "End" ? items.length - 1 : 0]?.focus()
      return
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  onMount(() => {
    const settled = textSelectionController.onSettled((snapshot) => {
      if (!snapshot) {
        // A click inside the toolbar collapses the page selection; that is intent, not dismissal.
        if (surface?.contains(document.activeElement)) return
        if (state()?.kind === "menu") close()
        return
      }
      const anchor = textSelectionController.anchor()
      if (!anchor || !opensOnSelection(snapshot)) return
      open(snapshot, anchor)
    })
    const registry = textSelectionController.onActionsChanged(() => {
      setRegistryVersion((value) => value + 1)
      const current = state()
      if (current && "action" in current && !textSelectionController.hasAction(current.action.id)) close()
    })
    const onContextMenu = (event: MouseEvent) => {
      const snapshot = textSelectionController.current()
      const anchor = textSelectionController.anchor()
      if (!snapshot || !anchor || !textSelectionController.owns(event.target as Node)) return
      // Reading surfaces get the toolbar here too, because a right-click on a
      // fresh selection can land before the settle timer has fired.
      if (!opensOnSelection(snapshot)) return
      event.preventDefault()
      open(snapshot, anchor)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (surface?.contains(event.target as Node)) return
      close()
    }
    const dismiss = () => close()
    document.addEventListener("selectionchange", trackSelection)
    document.addEventListener("contextmenu", onContextMenu)
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("blur", dismiss)
    window.addEventListener("resize", dismiss)
    window.addEventListener("popstate", dismiss)
    document.addEventListener("scroll", dismiss, true)
    onCleanup(() => {
      settled()
      registry()
      document.removeEventListener("selectionchange", trackSelection)
      document.removeEventListener("contextmenu", onContextMenu)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("blur", dismiss)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("popstate", dismiss)
      document.removeEventListener("scroll", dismiss, true)
      close()
    })
  })

  createEffect(() => {
    const current = state()
    if (!current) return
    setPosition({ x: current.anchor.x, y: current.anchor.y })
    requestAnimationFrame(() => {
      if (!surface || window.matchMedia("(max-width: 639px)").matches) return
      const rect = surface.getBoundingClientRect()
      setPosition(
        placeTextActionSurface(
          current.anchor,
          { width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      )
    })
  })

  const pluginActions = createMemo(() => {
    registryVersion()
    const current = state()
    return current?.kind === "menu" ? presentTextActions(textSelectionController.actionsFor(current.snapshot)) : []
  })

  const resultWidth = () => {
    const current = state()
    if (!current || !("action" in current)) return undefined
    const width = current.action.presentation?.width
    if (width === "sm") return "20rem"
    if (width === "lg") return "34rem"
    return "26rem"
  }

  const heading = () => {
    const current = state()
    return current && "action" in current ? current.action.label : i18n._(TS.toolbar)
  }

  const result = () => {
    const current = state()
    return current?.kind === "result" ? current : undefined
  }

  const failure = () => {
    const current = state()
    return current?.kind === "error" ? current : undefined
  }

  const ActionHeader = (props: { label: string }) => (
    <div class="selection-toolbar-header">
      <span class="selection-toolbar-heading">{props.label}</span>
      <button
        type="button"
        data-action="close"
        class="selection-toolbar-item"
        aria-label={i18n._(TS.close)}
        onClick={() => close()}
      >
        <Icon name={getSemanticIcon("action.close")} size="small" />
      </button>
    </div>
  )

  const Result = (props: { value: Extract<State, { kind: "result" }> }) => {
    const [component] = createResource(() => props.value.action.presentation!.load())
    return (
      <Show when={component()?.default} fallback={<div class="selection-toolbar-note">{i18n._(TS.loading)}</div>}>
        {(loaded) => (
          <Dynamic
            component={loaded()}
            invocationId={props.value.snapshot.selectionId}
            selection={props.value.snapshot}
            output={props.value.output}
            close={() => close()}
          />
        )}
      </Show>
    )
  }

  return (
    <Show when={state()}>
      {(current) => (
        <div
          ref={surface}
          data-component="selection-toolbar"
          data-kind={current().kind}
          role={current().kind === "menu" ? "toolbar" : "dialog"}
          aria-label={heading()}
          aria-busy={current().kind === "loading" ? "true" : undefined}
          style={{
            left: `${position().x}px`,
            top: `${position().y}px`,
            ...(current().kind === "menu" ? {} : { width: resultWidth() }),
          }}
        >
          <Show when={current().kind === "menu"}>
            <div class="selection-toolbar-row">
              <button
                type="button"
                data-action="copy"
                class="selection-toolbar-item"
                onClick={() => void copy(current().snapshot)}
              >
                <Icon name={getSemanticIcon("action.copy")} size="small" />
                <span>{i18n._(TS.copy)}</span>
              </button>
              <Show when={canQuoteSelection(current().snapshot) && quoteTarget()?.available()}>
                <span class="selection-toolbar-separator" role="presentation" />
                <button
                  type="button"
                  data-action="quote"
                  class="selection-toolbar-item"
                  data-emphasis
                  onClick={() => addToChat(current().snapshot)}
                >
                  <Icon name={getSemanticIcon("prompt.quote")} size="small" />
                  <span>{i18n._(TS.addToChat)}</span>
                </button>
              </Show>
              <For each={pluginActions()}>
                {(item) => (
                  <>
                    <span class="selection-toolbar-separator" role="presentation" />
                    <button
                      type="button"
                      data-action={item.action.id}
                      class="selection-toolbar-item"
                      onClick={() =>
                        void run({ action: item.action, snapshot: current().snapshot, anchor: current().anchor })
                      }
                    >
                      <Show when={item.action.icon}>{(icon) => <Icon name={icon()} size="small" />}</Show>
                      <span>{item.label}</span>
                    </button>
                  </>
                )}
              </For>
            </div>
          </Show>
          <Show when={current().kind === "loading"}>
            <ActionHeader label={heading()} />
            <div class="selection-toolbar-note">{i18n._(TS.loading)}</div>
          </Show>
          <Show when={result()}>
            {(value) => (
              <>
                <ActionHeader label={value().action.label} />
                <Result value={value()} />
              </>
            )}
          </Show>
          <Show when={failure()}>
            {(value) => (
              <>
                <ActionHeader label={value().action.label} />
                <div class="selection-toolbar-note" data-tone="error">
                  <span>{i18n._(TS.failed)}</span>
                  <span class="selection-toolbar-message">{value().message}</span>
                </div>
                <div class="selection-toolbar-row">
                  <button
                    type="button"
                    data-action="retry"
                    class="selection-toolbar-item"
                    onClick={() => void run(value())}
                  >
                    <span>{i18n._(TS.retry)}</span>
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
