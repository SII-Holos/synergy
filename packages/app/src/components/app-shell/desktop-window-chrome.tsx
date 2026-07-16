import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLingui } from "@lingui/solid"
import { usePlatform, type DesktopWindowState } from "@/context/platform"
import { BRAND_ASSETS, brandAssetPath } from "@/utils/brand-assets"
import {
  desktopWindowChromeVisible,
  desktopWindowToggleIcon,
  desktopWindowToggleLabel,
} from "./desktop-window-chrome-model"
import "./desktop-window-chrome.css"

export function DesktopWindowChrome() {
  const platform = usePlatform()
  const { _ } = useLingui()
  const [store, setStore] = createStore<{ state: DesktopWindowState | null }>({
    state: null,
  })

  const visible = () => desktopWindowChromeVisible(platform)
  const bridge = () => platform.desktopWindow
  const toggleIcon = createMemo(() => desktopWindowToggleIcon(store.state))
  const toggleLabel = createMemo(() => _(desktopWindowToggleLabel(store.state)))

  onMount(() => {
    if (!visible()) return
    const desktopWindow = bridge()
    if (!desktopWindow) return

    void desktopWindow.state().then((state) => {
      setStore("state", state)
    })

    const dispose = desktopWindow.onEvent?.((event) => {
      if (event.type !== "state") return
      setStore("state", event.state)
    })
    onCleanup(() => dispose?.())
  })

  function minimize() {
    void bridge()?.minimize()
  }

  function toggleMaximize() {
    void bridge()
      ?.toggleMaximize()
      .then((state) => {
        setStore("state", state)
      })
  }

  function close() {
    void bridge()?.close()
  }

  return (
    <Show when={visible()}>
      <header class="desktop-window-chrome" data-component="desktop-window-chrome">
        <div class="desktop-window-chrome__brand">
          <img
            src={brandAssetPath(BRAND_ASSETS.synergy.productIcon)}
            alt=""
            class="desktop-window-chrome__icon"
            draggable={false}
          />
          <span class="desktop-window-chrome__title">{_({ id: "app.name.synergy", message: "Synergy" })}</span>
        </div>
        <div class="desktop-window-chrome__drag-region" />
        <div class="desktop-window-chrome__controls">
          <button
            type="button"
            class="desktop-window-chrome__control"
            aria-label={_({ id: "window.minimize.aria", message: "Minimize" })}
            title={_({ id: "window.minimize.title", message: "Minimize" })}
            onClick={minimize}
          >
            <Icon name={getSemanticIcon("window.minimize")} size="small" />
          </button>
          <button
            type="button"
            class="desktop-window-chrome__control"
            aria-label={toggleLabel()}
            title={toggleLabel()}
            onClick={toggleMaximize}
          >
            <Icon name={getSemanticIcon(toggleIcon())} size="small" />
          </button>
          <button
            type="button"
            class="desktop-window-chrome__control desktop-window-chrome__control--close"
            aria-label={_({ id: "window.close.aria", message: "Close" })}
            title={_({ id: "window.close.title", message: "Close" })}
            onClick={close}
          >
            <Icon name={getSemanticIcon("window.close")} size="small" />
          </button>
        </div>
      </header>
    </Show>
  )
}
