import { Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { desktopWindowNativeChromeActive } from "@/components/desktop-window-chrome-model"
import "./desktop-native-titlebar.css"

export function DesktopNativeTitlebar(props: { onSearchOpen: () => void }) {
  const layout = useLayout()
  const platform = usePlatform()
  const expanded = () => layout.sidebar.opened()

  return (
    <Show when={desktopWindowNativeChromeActive(platform)}>
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
      </header>
    </Show>
  )
}
