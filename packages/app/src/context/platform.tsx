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

export type DesktopThemeSource = "system" | "light" | "dark"
export type DesktopThemeEffective = "light" | "dark"
export type DesktopThemeSnapshot = {
  source: DesktopThemeSource
  effective: DesktopThemeEffective
}
export type DesktopThemeBridge = {
  get(): Promise<DesktopThemeSnapshot | null>
  set(source: DesktopThemeSource): Promise<DesktopThemeSnapshot | null>
  onEvent?(listener: (event: { type: "theme"; snapshot: DesktopThemeSnapshot }) => void): () => void
}

export type DesktopUpdateMode = "auto" | "notify" | "manual" | "none"
export type DesktopUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error"

export type DesktopUpdateStatus = {
  channel: "dev" | "stable"
  mode: DesktopUpdateMode
  phase: DesktopUpdatePhase
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  lastCheckedAt: number | null
  error: string | null
}

export type DesktopUpdateBridge = {
  status(): Promise<DesktopUpdateStatus | null>
  setMode(mode: DesktopUpdateMode): Promise<DesktopUpdateStatus | null>
  check(input?: { manual?: boolean }): Promise<DesktopUpdateStatus | null>
  download(): Promise<DesktopUpdateStatus | null>
  installAndRestart(): Promise<DesktopUpdateStatus | null>
  onEvent?(listener: (event: { type: "status"; status: DesktopUpdateStatus }) => void): () => void
}

export type DesktopServerStatus = {
  mode: "managed" | "external"
  state: "stopped" | "starting" | "running" | "failed" | "external"
  url: string | null
  port: number | null
  pid: number | null
  lastError: string | null
  logFile: string | null
}

export type DesktopServerBridge = {
  status(): Promise<DesktopServerStatus | null>
  restart(): Promise<DesktopServerStatus | null>
}

export type DesktopWindowState = {
  maximized: boolean
  fullscreen: boolean
  focused: boolean
}

export type DesktopWindowBridge = {
  chrome: "custom" | "native"
  minimize(): Promise<void>
  toggleMaximize(): Promise<DesktopWindowState | null>
  close(): Promise<void>
  state(): Promise<DesktopWindowState | null>
  onEvent?(listener: (event: { type: "state"; state: DesktopWindowState }) => void): () => void
}

export type ClipboardBridge = {
  writeText(text: string): Promise<boolean>
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

  /** Desktop product update bridge, provided by the desktop shell. */
  desktopUpdate?: DesktopUpdateBridge

  /** Desktop managed server bridge, provided by the desktop shell. */
  desktopServer?: DesktopServerBridge

  /** Desktop window controls bridge, provided by the desktop shell. */
  desktopWindow?: DesktopWindowBridge

  /** Desktop theme bridge, provided by the desktop shell. */
  desktopTheme?: DesktopThemeBridge

  /** Clipboard bridge, provided by the desktop shell when browser clipboard permissions are not enough. */
  clipboard?: ClipboardBridge
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
