import { Show, onCleanup } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLayout } from "@/context/layout"
import { useDesktopTitlebar } from "@/context/desktop-titlebar"
import "./desktop-native-titlebar.css"

export function DesktopNativeTitlebar(props: { onSearchOpen: () => void }) {
  const layout = useLayout()
  const titlebar = useDesktopTitlebar()
  const expanded = () => layout.sidebar.opened()
  let host: HTMLDivElement | undefined

  onCleanup(() => {
    if (host && titlebar?.host() === host) titlebar.setHost(undefined)
  })

  return (
    <Show when={titlebar?.active()}>
      <header class="desktop-native-titlebar" data-component="desktop-native-titlebar">
        <div class="desktop-native-titlebar__sidebar-area">
          <div class="desktop-native-titlebar__traffic-space" />
          <div class="desktop-native-titlebar__controls">
            <Tooltip value={expanded() ? "Collapse sidebar" : "Expand sidebar"} placement="bottom">
              <button
                type="button"
                class="desktop-native-titlebar__button desktop-native-titlebar__button--sidebar"
                aria-label={expanded() ? "Collapse sidebar" : "Expand sidebar"}
                aria-pressed={expanded()}
                onClick={() => layout.sidebar.toggle()}
              >
                <Icon name={getSemanticIcon("app.sidebar")} size="normal" />
              </button>
            </Tooltip>
            <Tooltip value="Search sessions" placement="bottom">
              <button
                type="button"
                class="desktop-native-titlebar__button desktop-native-titlebar__button--search"
                aria-label="Search sessions"
                onClick={props.onSearchOpen}
              >
                <Icon name={getSemanticIcon("action.search")} size="normal" />
              </button>
            </Tooltip>
          </div>
          <div class="desktop-native-titlebar__sidebar-drag-region" />
        </div>
        <div
          ref={(element) => {
            host = element
            titlebar?.setHost(element)
          }}
          class="desktop-native-titlebar__content"
        />
      </header>
    </Show>
  )
}
