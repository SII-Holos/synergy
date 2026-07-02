import { createContext, createMemo, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"
import { desktopWindowNativeChromeActive } from "@/components/desktop-window-chrome-model"
import { usePlatform } from "@/context/platform"

export type DesktopTitlebarContextValue = {
  active: Accessor<boolean>
  host: Accessor<HTMLElement | undefined>
  setHost: (host: HTMLElement | undefined) => void
}

const DesktopTitlebarContext = createContext<DesktopTitlebarContextValue>()

export function DesktopTitlebarProvider(props: ParentProps) {
  const platform = usePlatform()
  const [host, setHost] = createSignal<HTMLElement>()
  const active = createMemo(() => desktopWindowNativeChromeActive(platform))

  return (
    <DesktopTitlebarContext.Provider value={{ active, host, setHost }}>
      {props.children}
    </DesktopTitlebarContext.Provider>
  )
}

export function useDesktopTitlebar() {
  return useContext(DesktopTitlebarContext)
}
