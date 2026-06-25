import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"

export type BrowserNativeViewRequest = {
  sessionID: string
  routeDirectory?: string
  tabId: string
}

export type BrowserNativeViewBridge = {
  attachView(input: BrowserNativeViewRequest): Promise<void>
  detachView(input: { tabId: string }): Promise<void>
  focusView(input: { tabId: string }): Promise<void>
  resizeView(input: { tabId: string; width: number; height: number }): Promise<void>
}

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog */
  openDirectoryPickerDialog?(opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>

  /** Fetch override */
  fetch?: typeof fetch

  /** Native Chromium Browser view bridge, provided by the desktop shell. */
  browserNative?: BrowserNativeViewBridge
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
