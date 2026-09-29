import type {
  BrowserBackendCommand,
  BrowserBackendResult,
  BrowserHostDownloadEntry,
} from "@ericsanchezok/synergy-browser-core"

export interface BrowserFileChooserRequest {
  requestId: string
  multiple: boolean
  accept: string[]
}

export interface BrowserDialogRequest {
  requestId: string
  type: string
  message: string
  defaultValue?: string
}

export interface BrowserPageEventHandlers {
  onLoading?: (page: BrowserPageBackend, url: string) => void
  onLoaded?: (page: BrowserPageBackend) => void
  onUpdated?: (page: BrowserPageBackend) => void
  onError?: (page: BrowserPageBackend, message: string) => void
  onCrashed?: (page: BrowserPageBackend, message: string) => void
  onDownload?: (page: BrowserPageBackend, entry: BrowserHostDownloadEntry) => void
  onFileChooser?: (page: BrowserPageBackend, request: BrowserFileChooserRequest) => void
  onDialog?: (page: BrowserPageBackend, request: BrowserDialogRequest) => void
}

export interface BrowserPageBackend {
  readonly id: string
  readonly backend: "host"
  url: string
  title: string
  loading: boolean
  lastActiveAt: number | null
  isAlive(): boolean
  execute(command: BrowserBackendCommand): Promise<BrowserBackendResult>
  close(): Promise<void>
}
