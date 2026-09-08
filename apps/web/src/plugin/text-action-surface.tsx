import { ErrorBoundary, For, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { Dynamic } from "solid-js/web"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLocale } from "@/context/locale"
import {
  groupTextActions,
  textSelectionController,
  type TextAction,
  type TextSelectionSnapshot,
} from "@/context/text-selection"
import { PII } from "./plugin-interaction-i18n"
import { placeTextActionSurface, type TextActionPoint } from "./text-action-position"

const SENSITIVE_SELECTION_SELECTOR =
  'input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"], [data-sensitive], [data-selection-excluded]'

type Anchor = TextActionPoint
type SurfaceState =
  | { kind: "menu"; anchor: Anchor; snapshot: TextSelectionSnapshot; editable: boolean }
  | { kind: "loading"; anchor: Anchor; snapshot: TextSelectionSnapshot; action: TextAction; invocationId: string }
  | {
      kind: "result"
      anchor: Anchor
      snapshot: TextSelectionSnapshot
      action: TextAction
      invocationId: string
      output: unknown
    }
  | {
      kind: "error"
      anchor: Anchor
      snapshot: TextSelectionSnapshot
      action: TextAction
      invocationId: string
      message: string
    }

function selectionElement(node: Node | null) {
  return node instanceof Element ? node : node?.parentElement
}

function selectionOwner(node: Node | null) {
  const element = selectionElement(node)
  return (
    element?.closest(
      "[data-message-id], [data-message], [data-text-selection-surface], input, textarea, [contenteditable='true']",
    ) ?? element
  )
}

function excludedSelectionNode(node: Node | null) {
  const element = selectionElement(node)
  return !element || !!element.closest(SENSITIVE_SELECTION_SELECTOR)
}

function selectionOrigin(owner: Element) {
  const message = owner.closest<HTMLElement>("[data-message-id], [data-message]")
  const role = message?.dataset.messageRole
  if (role === "user") return "user_message" as const
  if (role === "assistant") return "assistant_message" as const
  if (owner.closest('input, textarea, [contenteditable="true"]')) return "editable" as const
  return "other" as const
}

function rangeAnchor(range: Range) {
  const rect = range.getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

function viewportAnchor(event: MouseEvent) {
  if (event.detail !== 0 && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX, y: event.clientY }
  }
  const anchor = textSelectionController.anchor()
  return anchor ? { x: anchor.x, y: anchor.y + anchor.height } : { x: 12, y: 12 }
}

function widthClass(action?: TextAction) {
  if (!action) return "sm:w-[18rem]"
  if (action?.presentation?.width === "sm") return "sm:w-[20rem]"
  if (action?.presentation?.width === "lg") return "sm:w-[34rem]"
  return "sm:w-[26rem]"
}

function widthValue(action?: TextAction) {
  if (!action) return "18rem"
  if (action?.presentation?.width === "sm") return "20rem"
  if (action?.presentation?.width === "lg") return "34rem"
  return "26rem"
}

export function PluginTextActionSurface() {
  const { i18n } = useLocale()
  const [version, setVersion] = createSignal(0)
  const [state, setState] = createSignal<SurfaceState>()
  const [position, setPosition] = createSignal<Anchor>({ x: 8, y: 8 })
  let surfaceRef: HTMLDivElement | undefined
  let invocation: AbortController | undefined
  let trigger: HTMLElement | undefined

  const close = (restoreFocus = false) => {
    invocation?.abort()
    invocation = undefined
    setState()
    if (restoreFocus) trigger?.focus()
    trigger = undefined
  }

  const refreshDOMSelection = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      textSelectionController.update(undefined)
      return
    }
    const range = selection.getRangeAt(0)
    const owner = selectionOwner(range.commonAncestorContainer)
    const excluded =
      !owner ||
      excludedSelectionNode(selection.anchorNode) ||
      excludedSelectionNode(selection.focusNode) ||
      !!range.cloneContents().querySelector(SENSITIVE_SELECTION_SELECTOR)
    textSelectionController.update(selection.toString(), {
      excluded,
      source: "document",
      origin: owner ? selectionOrigin(owner) : "other",
      editable: !!owner?.closest('input, textarea, [contenteditable="true"]'),
      wholeContainer: !!owner && selection.toString().trim() === (owner.textContent ?? "").trim(),
      owner: owner ?? undefined,
      anchor: rangeAnchor(range),
    })
  }

  const refreshEditableSelection = (target: EventTarget | null) => {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
    const excluded = !!target.closest(SENSITIVE_SELECTION_SELECTOR)
    const start = target.selectionStart ?? 0
    const end = target.selectionEnd ?? start
    const text = start === end ? undefined : target.value.slice(start, end)
    const rect = target.getBoundingClientRect()
    textSelectionController.update(text, {
      excluded,
      source: "document",
      origin: "editable",
      editable: true,
      wholeContainer: start === 0 && end === target.value.length,
      owner: target,
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    })
  }

  onMount(() => {
    const actionsChanged = textSelectionController.onActionsChanged(() => {
      setVersion((value) => value + 1)
      const current = state()
      if (current && "action" in current && !textSelectionController.hasAction(current.action.id)) {
        close(true)
      }
    })
    const onSelect = (event: Event) => refreshEditableSelection(event.target)
    const onContextMenu = (event: MouseEvent) => {
      version()
      refreshEditableSelection(event.target)
      const snapshot = textSelectionController.current()
      const eligible = snapshot ? textSelectionController.actionsFor(snapshot) : []
      if (!snapshot || eligible.length === 0) return
      if (!textSelectionController.owns(event.target as Node)) return
      event.preventDefault()
      invocation?.abort()
      invocation = undefined
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      setState({
        kind: "menu",
        anchor: viewportAnchor(event),
        snapshot,
        editable: snapshot.editable,
      })
      requestAnimationFrame(() => surfaceRef?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus())
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!surfaceRef || surfaceRef.contains(event.target as Node)) return
      close()
    }
    const dismiss = () => close()
    document.addEventListener("selectionchange", refreshDOMSelection)
    document.addEventListener("select", onSelect, true)
    document.addEventListener("contextmenu", onContextMenu)
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("blur", dismiss)
    window.addEventListener("resize", dismiss)
    window.addEventListener("popstate", dismiss)
    document.addEventListener("scroll", dismiss, true)
    onCleanup(() => {
      actionsChanged()
      document.removeEventListener("selectionchange", refreshDOMSelection)
      document.removeEventListener("select", onSelect, true)
      document.removeEventListener("contextmenu", onContextMenu)
      document.removeEventListener("pointerdown", onPointerDown, true)
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
    setPosition(current.anchor)
    requestAnimationFrame(() => {
      if (!surfaceRef || window.matchMedia("(max-width: 639px)").matches) return
      const rect = surfaceRef.getBoundingClientRect()
      setPosition(
        placeTextActionSurface(
          current.anchor,
          { width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      )
      surfaceRef
        .querySelector<HTMLElement>(
          '[autofocus], button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )
        ?.focus()
    })
  })

  const run = async (action: TextAction, snapshot: TextSelectionSnapshot, anchor: Anchor) => {
    invocation?.abort()
    const controller = new AbortController()
    invocation = controller
    if (!action.presentation) {
      try {
        await textSelectionController.run(action.id, snapshot, controller.signal)
        close(true)
      } catch (error) {
        if (controller.signal.aborted) return
        showToast({
          type: "error",
          title: i18n._(PII.failed),
          description: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    const invocationId = generateUUID()
    setState({ kind: "loading", anchor, snapshot, action, invocationId })
    try {
      const output = await textSelectionController.run(action.id, snapshot, controller.signal)
      if (controller.signal.aborted) return
      setState({ kind: "result", anchor, snapshot, action, invocationId, output })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({
        kind: "error",
        anchor,
        snapshot,
        action,
        invocationId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const nativeAction = async (kind: "copy" | "cut" | "paste" | "selectAll") => {
    try {
      if (kind === "copy") {
        const text = state()?.kind === "menu" ? state()?.snapshot.text : undefined
        if (text) await navigator.clipboard.writeText(text)
      } else {
        trigger?.focus()
        if (kind === "paste") {
          const text = await navigator.clipboard.readText()
          if (!document.execCommand("insertText", false, text)) throw new Error(i18n._(PII.unavailable))
        } else if (!document.execCommand(kind)) {
          throw new Error(i18n._(PII.unavailable))
        }
      }
      close(true)
    } catch (error) {
      showToast({
        type: "error",
        title: i18n._(PII.failed),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key === "Tab") {
      const focusable = [
        ...(surfaceRef?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ]
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
      return
    }
    const current = state()
    if (current?.kind !== "menu" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const buttons = [...(surfaceRef?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
    if (buttons.length === 0) return
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (index + 1 + buttons.length) % buttons.length
            : (index - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  const Result = (props: { value: Extract<SurfaceState, { kind: "result" }> }) => {
    const [component] = createResource(() => props.value.action.presentation!.load())
    createEffect(() => {
      if (component.error) {
        setState({
          kind: "error",
          anchor: props.value.anchor,
          snapshot: props.value.snapshot,
          action: props.value.action,
          invocationId: props.value.invocationId,
          message: component.error instanceof Error ? component.error.message : String(component.error),
        })
      }
    })
    return (
      <Show when={component()?.default} fallback={<Loading />}>
        {(loaded) => (
          <ErrorBoundary
            fallback={(error) => (
              <ErrorContent message={error instanceof Error ? error.message : String(error)} value={props.value} />
            )}
          >
            <Dynamic
              component={loaded()}
              invocationId={props.value.invocationId}
              selection={props.value.snapshot}
              output={props.value.output}
              close={() => close(true)}
            />
          </ErrorBoundary>
        )}
      </Show>
    )
  }

  const Loading = () => (
    <div class="flex min-h-28 items-center justify-center gap-3 px-5 py-6 text-13-regular text-text-weak">
      <span class="plugin-text-action-spinner" aria-hidden="true" />
      <span>{i18n._(PII.loading)}</span>
    </div>
  )

  const ErrorContent = (props: { message: string; value: Extract<SurfaceState, { kind: "error" | "result" }> }) => (
    <div class="space-y-4 p-5">
      <div>
        <div class="text-14-medium text-text-strong">{i18n._(PII.failed)}</div>
        <div class="mt-1 break-words text-12-regular text-text-weak">{props.message}</div>
      </div>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded-md border border-border-base px-3 py-2 text-13-medium text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
          onClick={() => void run(props.value.action, props.value.snapshot, props.value.anchor)}
        >
          {i18n._(PII.retry)}
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-2 text-13-medium text-text-weak hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
          onClick={() =>
            setState({
              kind: "menu",
              anchor: props.value.anchor,
              snapshot: props.value.snapshot,
              editable: props.value.snapshot.editable,
            })
          }
        >
          {i18n._(PII.back)}
        </button>
      </div>
    </div>
  )

  return (
    <Show when={state()}>
      {(current) => {
        const action = () => {
          const value = current()
          return "action" in value ? value.action : undefined
        }
        const editable = () => {
          const value = current()
          return value.kind === "menu" ? value.editable : false
        }
        const resultState = () => {
          const value = current()
          return value.kind === "result" ? value : undefined
        }
        const errorState = () => {
          const value = current()
          return value.kind === "error" ? value : undefined
        }
        const groups = () =>
          current().kind === "menu" ? groupTextActions(textSelectionController.actionsFor(current().snapshot)) : []
        return (
          <div
            ref={surfaceRef}
            role={current().kind === "menu" ? "menu" : "dialog"}
            aria-modal={current().kind === "menu" ? undefined : "true"}
            aria-busy={current().kind === "loading" ? "true" : undefined}
            aria-label={current().kind === "menu" ? i18n._(PII.menu) : action()?.label}
            onKeyDown={onKeyDown}
            class={`fixed inset-x-2 bottom-2 z-50 max-h-[min(42rem,calc(100vh-1rem))] overflow-y-auto rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha shadow-md max-sm:!bottom-2 max-sm:!left-2 max-sm:!right-2 max-sm:!top-auto sm:inset-auto sm:bottom-auto sm:max-h-[calc(100vh-1rem)] ${widthClass(action())}`}
            style={`--text-action-width:${widthValue(action())};left:${position().x}px;top:${position().y}px`}
          >
            <Show when={current().kind !== "menu"}>
              <div class="flex min-h-11 items-center justify-between gap-3 border-b border-border-base px-4 py-2">
                <span class="min-w-0 truncate text-12-medium text-text-weak">{action()?.label}</span>
                <button
                  type="button"
                  aria-label={i18n._(PII.close)}
                  class="flex size-8 shrink-0 items-center justify-center rounded-md text-16-regular text-text-weak hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                  onClick={() => close(true)}
                >
                  ×
                </button>
              </div>
            </Show>
            <Show when={current().kind === "menu"}>
              <div class="p-1">
                <button
                  type="button"
                  role="menuitem"
                  class="flex min-h-8 w-full rounded-md px-2.5 py-1.5 text-left text-13-regular text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus max-sm:min-h-11"
                  onClick={() => void nativeAction("copy")}
                >
                  {i18n._(PII.copy)}
                </button>
                <Show when={editable()}>
                  <For each={["cut", "paste", "selectAll"] as const}>
                    {(kind) => (
                      <button
                        type="button"
                        role="menuitem"
                        class="flex min-h-8 w-full rounded-md px-2.5 py-1.5 text-left text-13-regular text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus max-sm:min-h-11"
                        onClick={() => void nativeAction(kind)}
                      >
                        {i18n._(kind === "cut" ? PII.cut : kind === "paste" ? PII.paste : PII.selectAll)}
                      </button>
                    )}
                  </For>
                </Show>
                <div role="separator" class="my-1 border-t border-border-base" />
                <For each={groups()}>
                  {(group) => (
                    <div role="group" aria-label={group.pluginName}>
                      <div class="px-2.5 pb-0.5 pt-1.5 text-11-medium text-text-weak">{group.pluginName}</div>
                      <For each={group.actions}>
                        {(item) => (
                          <button
                            type="button"
                            role="menuitem"
                            class="flex min-h-8 w-full items-center rounded-md px-2.5 py-1.5 text-left text-13-regular text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus max-sm:min-h-11"
                            onClick={() =>
                              current().kind === "menu" && void run(item, current().snapshot, current().anchor)
                            }
                          >
                            <Show when={item.icon}>
                              {(icon) => <Icon name={icon()} size="small" class="mr-2 shrink-0" />}
                            </Show>
                            <span class="min-w-0 truncate">{item.label}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={current().kind === "loading"}>
              <Loading />
            </Show>
            <Show when={resultState()}>{(value) => <Result value={value()} />}</Show>
            <Show when={errorState()}>{(value) => <ErrorContent message={value().message} value={value()} />}</Show>
          </div>
        )
      }}
    </Show>
  )
}
