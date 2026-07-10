import { Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { desktopWindowNativeChromeActive } from "./desktop-window-chrome-model"
import "./desktop-native-titlebar.css"

export function DesktopNativeTitlebar() {
  const platform = usePlatform()

  return (
    <Show when={desktopWindowNativeChromeActive(platform)}>
      <header class="desktop-native-titlebar" data-component="desktop-native-titlebar">
        <div class="desktop-native-titlebar__traffic-space" />
        <div class="desktop-native-titlebar__drag-region" />
      </header>
    </Show>
  )
}
