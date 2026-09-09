import { createSimpleContext } from "@ericsanchezok/synergy-ui/context"
import type {
  BrowserNativeAttachRequest,
  BrowserNativePageRequest,
  BrowserNativePresentationCapabilityRequest,
  BrowserNativePresentationCapabilityResult,
  BrowserNativePresentationTicketRequest,
  BrowserNativePresentationTicketResult,
  BrowserNativeResizeRequest,
  BrowserNativeViewEvent,
} from "@ericsanchezok/synergy-browser"

export type BrowserNativeViewBridge = {
  attachView(input: BrowserNativeAttachRequest): Promise<void>
  detachView(input: BrowserNativePageRequest): Promise<void>
  focusView(input: BrowserNativePageRequest): Promise<void>
  resizeView(input: BrowserNativeResizeRequest): Promise<void>
  retryPage(input: BrowserNativePageRequest): Promise<void>
  presentationCapability(
    input: BrowserNativePresentationCapabilityRequest,
  ): Promise<BrowserNativePresentationCapabilityResult>
  createPresentationTicket(
    input: BrowserNativePresentationTicketRequest,
  ): Promise<BrowserNativePresentationTicketResult>
  onEvent?(listener: (event: BrowserNativeViewEvent) => void): () => void
}

export type DesktopThemeSource = "system" | "light" | "dark"
export type DesktopThemeEffective = "light" | "dark"
export type DesktopShellSkinColors = {
  background: string
  text: string
  mutedText: string
  panel: string
  border: string
  control: string
  controlHover: string
  controlHoverBackground: string
  focus: string
  markBackground: string
  markText: string
  criticalBackground: string
  criticalText: string
}
export type DesktopSkinUpdate = {
  source: DesktopThemeSource
  themeId: string
  light: DesktopShellSkinColors
  dark: DesktopShellSkinColors
}
export type DesktopThemeSnapshot = {
  version: 2
  source: DesktopThemeSource
  effective: DesktopThemeEffective
  themeId: string
  light: DesktopShellSkinColors
  dark: DesktopShellSkinColors
  colors: DesktopShellSkinColors
}
export type DesktopThemeBridge = {
  get(): Promise<DesktopThemeSnapshot | null>
  set(input: DesktopSkinUpdate): Promise<DesktopThemeSnapshot | null>
  setSource(source: DesktopThemeSource): Promise<DesktopThemeSnapshot | null>
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

export type DesktopShellEnvironmentDiagnostics = {
  source: "login-shell" | "inherited"
  shell: string | null
  path: string
  commands: Array<{ command: string; path: string | null }>
  warning: "login-shell-unavailable" | null
}

export type DesktopServerStatus = {
  mode: "managed" | "external"
  state: "stopped" | "starting" | "running" | "failed" | "external"
  url: string | null
  port: number | null
  pid: number | null
  lastError: string | null
  logFile: string | null
  shellEnvironment: DesktopShellEnvironmentDiagnostics | null
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

export type DesktopZoomBridge = {
  get(): Promise<number>
  set(zoomFactor: number): Promise<number>
}

export type ClipboardBridge = {
  writeText(text: string): Promise<boolean>
}

export type DesktopBadgeBridge = {
  setState(state: { count: number }): Promise<void>
}

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** App version */
  version?: string

  /** Diagnostic build identity; source builds include the Git revision. */
  buildLabel?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification (optional deep link; tag collapses duplicates) */
  notify(title: string, description?: string, href?: string, tag?: string): Promise<void>

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

  /** Desktop unread badge bridge, provided by the desktop shell. */
  desktopBadge?: DesktopBadgeBridge

  /** Desktop window zoom bridge, provided by the desktop shell. */
  desktopZoom?: DesktopZoomBridge

  /** Clipboard bridge, provided by the desktop shell when browser clipboard permissions are not enough. */
  clipboard?: ClipboardBridge
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
