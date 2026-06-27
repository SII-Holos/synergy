import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"

export type BrowserNativeViewRequest = {
  serverUrl?: string
  sessionID: string
  routeDirectory?: string
  directory?: string
  scopeID?: string
  scopeKey?: string
  pageId: string
  url?: string
  bounds?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type BrowserNativeViewBridge = {
  attachView(input: BrowserNativeViewRequest): Promise<void>
  detachView(input: { pageId: string }): Promise<void>
  focusView(input: { pageId: string }): Promise<void>
  resizeView(input: { pageId: string; width: number; height: number; x?: number; y?: number }): Promise<void>
  onEvent?(listener: (event: BrowserNativeViewEvent) => void): () => void
}

export type BrowserNativeViewEvent =
  | { type: "native.loading"; pageId: string; url?: string }
  | { type: "native.loaded"; pageId: string; url?: string; title?: string }
  | { type: "native.navigated"; pageId: string; url: string }
  | { type: "native.title"; pageId: string; title: string }
  | { type: "native.console"; pageId: string; level: number; message: string; line?: number; sourceId?: string }
  | { type: "native.error"; pageId: string; code?: number; message: string; url?: string }

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
