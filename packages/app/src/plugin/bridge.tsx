import { For, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import {
  notifyExternalComposerSlotsChanged,
  setExternalComposerSlotLookup,
} from "@ericsanchezok/synergy-ui/composer-slots"
import {
  notifyExternalMessageSlotsChanged,
  setExternalMessageSlotLookup,
} from "@ericsanchezok/synergy-ui/message-slots"
import { useTheme } from "@ericsanchezok/synergy-ui/theme"
import { useGlobalSDK } from "@/context/global-sdk"
import { getComposerSlotsByName, subscribeComposerSlots } from "./registries/composer-slot-registry"
import { usePluginHost } from "./host"
import { textSelectionController } from "@/context/text-selection"
import { SelectionExtensionOutlet } from "./registries/selection-extension-registry"
import { useLocale } from "@/context/locale"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { PII } from "./plugin-interaction-i18n"
import { getMessageSlots, subscribeMessageSlots } from "./registries/message-slot-registry"
import { useLocation } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

setExternalComposerSlotLookup((slot) =>
  getComposerSlotsByName(slot).map((entry) => ({
    id: entry.id,
    component: entry.component,
    loader: entry.loader,
  })),
)

setExternalMessageSlotLookup((slot) =>
  getMessageSlots(slot).map((entry) => ({
    id: entry.id,
    loader: async () => {
      const loaded = await entry.loader()
      return {
        default: (props) =>
          entry.roles && props.role && !entry.roles.includes(props.role) ? null : loaded.default(props),
      }
    },
  })),
)

export function PluginComposerSlotBridge() {
  onMount(() => {
    const unsubscribe = subscribeComposerSlots(() => notifyExternalComposerSlotsChanged())
    const unsubscribeMessages = subscribeMessageSlots(() => notifyExternalMessageSlotsChanged())
    onCleanup(() => {
      unsubscribe()
      unsubscribeMessages()
    })
  })
  return null
}

export function PluginThemeConfigBridge() {
  const globalSDK = useGlobalSDK()
  const theme = useTheme()
  const host = usePluginHost()
  const [config] = createResource(async () => {
    const result = await globalSDK.client.config.global()
    return result.data
  })

  createEffect(() => {
    host.plugins()
    theme.themes()
    theme.setThemeId(config()?.theme ?? "")
  })

  return null
}

const SENSITIVE_SELECTION_SELECTOR =
  'input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"], [data-sensitive], [data-selection-excluded]'

function excludedSelectionNode(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement
  if (!element) return true
  return !!element.closest(SENSITIVE_SELECTION_SELECTOR)
}

function excludedSelection(selection: Selection | null) {
  if (!selection || selection.rangeCount === 0) return true
  if (excludedSelectionNode(selection.anchorNode) || excludedSelectionNode(selection.focusNode)) return true
  return !!selection.getRangeAt(0).cloneContents().querySelector(SENSITIVE_SELECTION_SELECTOR)
}

export function PluginTextInteractionBridge() {
  const location = useLocation()
  const { i18n } = useLocale()
  const [version, setVersion] = createSignal(0)
  const [menu, setMenu] = createSignal<{ x: number; y: number; editable: boolean }>()
  const [pending, setPending] = createSignal<string>()
  let menuRef: HTMLDivElement | undefined
  let invocation: AbortController | undefined
  let menuTrigger: HTMLElement | undefined
  const actions = () => {
    version()
    return textSelectionController.actions()
  }
  const close = (restoreFocus = false) => {
    invocation?.abort()
    invocation = undefined
    setPending()
    setMenu()
    if (restoreFocus) menuTrigger?.focus()
    menuTrigger = undefined
  }
  const dismiss = () => close()
  const refreshDOMSelection = () => {
    const selection = window.getSelection()
    textSelectionController.update(selection?.toString(), {
      excluded: excludedSelection(selection),
    })
  }

  onMount(() => {
    const actionsChanged = textSelectionController.onActionsChanged(() => setVersion((value) => value + 1))
    const onContextMenu = (event: MouseEvent) => {
      if (actions().length === 0) return
      const snapshot = textSelectionController.current()
      if (!snapshot && !textSelectionController.tooLarge()) return
      event.preventDefault()
      const target = event.target instanceof Element ? event.target : undefined
      menuTrigger = target instanceof HTMLElement ? target : undefined
      const editable = !!target?.closest('input:not([type="password"]), textarea, [contenteditable="true"]')
      const width = Math.min(352, window.innerWidth - 16)
      const estimatedHeight = Math.min(420, 52 + actions().length * 36 + (editable ? 108 : 36))
      setMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - estimatedHeight - 8)),
        editable,
      })
      requestAnimationFrame(() => menuRef?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus())
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef || menuRef.contains(event.target as Node)) return
      close()
    }
    document.addEventListener("selectionchange", refreshDOMSelection)
    document.addEventListener("contextmenu", onContextMenu)
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("blur", dismiss)
    window.addEventListener("resize", dismiss)
    onCleanup(() => {
      actionsChanged()
      document.removeEventListener("selectionchange", refreshDOMSelection)
      document.removeEventListener("contextmenu", onContextMenu)
      document.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("blur", dismiss)
      window.removeEventListener("resize", dismiss)
      close()
    })
  })

  const run = async (id: string) => {
    invocation?.abort()
    const controller = new AbortController()
    invocation = controller
    setPending(id)
    try {
      await textSelectionController.run(id, controller.signal)
      close(true)
    } catch (error) {
      if (controller.signal.aborted) return
      setPending()
      showToast({
        type: "error",
        title: i18n._(PII.failed),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close(true)
      return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const buttons = [...(menuRef?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + buttons.length) % buttons.length
            : (current - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  const nativeAction = async (kind: "copy" | "cut" | "paste" | "selectAll") => {
    try {
      if (kind === "copy") {
        const text = textSelectionController.current()?.text
        if (text) await navigator.clipboard.writeText(text)
      } else {
        menuTrigger?.focus()
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

  return (
    <>
      <SelectionExtensionOutlet mountKey={location.pathname} />
      <Show when={menu()}>
        {(state) => (
          <div
            ref={menuRef}
            role="menu"
            aria-busy={!!pending()}
            onKeyDown={onMenuKeyDown}
            class="fixed z-50 max-h-[calc(100vh-1rem)] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha p-1 shadow-lg"
            style={{ left: `${state().x}px`, top: `${state().y}px` }}
          >
            <Show
              when={!textSelectionController.tooLarge()}
              fallback={<div class="px-3 py-2 text-12-regular text-text-weak">{i18n._(PII.tooLarge)}</div>}
            >
              <button
                type="button"
                role="menuitem"
                class="flex w-full rounded-md px-3 py-2 text-left text-13-regular text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                onClick={() => void nativeAction("copy")}
              >
                {i18n._(PII.copy)}
              </button>
              <Show when={state().editable}>
                <For each={["cut", "paste", "selectAll"] as const}>
                  {(kind) => (
                    <button
                      type="button"
                      role="menuitem"
                      class="flex w-full rounded-md px-3 py-2 text-left text-13-regular text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                      onClick={() => void nativeAction(kind)}
                    >
                      {i18n._(kind === "cut" ? PII.cut : kind === "paste" ? PII.paste : PII.selectAll)}
                    </button>
                  )}
                </For>
              </Show>
              <div role="separator" class="my-1 border-t border-border-base" />
              <For each={actions()}>
                {(action) => (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!!pending()}
                    class="flex w-full rounded-md px-3 py-2 text-left text-13-regular text-text-strong hover:bg-surface-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus disabled:opacity-50"
                    onClick={() => void run(action.id)}
                  >
                    <Show when={action.icon}>{(icon) => <Icon name={icon()} size="small" class="mr-2" />}</Show>
                    {action.label}
                  </button>
                )}
              </For>
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}
