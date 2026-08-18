import { EventEmitter } from "node:events"
import { mock } from "bun:test"

// Desktop tests mock the electron module through a single shared namespace.
// bun's mock.module registry is per-worker and first-registration-wins, so
// every file that touches electron must register this same factory and
// configure the mutable state below for its own needs; any file-local
// electron mock would leak into sibling files that import real modules.

export const electronAppEmitter = new EventEmitter()

export interface ElectronMockState {
  whenReady: Promise<void>
  userDataPath: string
  displays: Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  permissionRequestHandlers: Array<
    (webContents: unknown, permission: unknown, callback: (granted: boolean) => void) => void
  >
  shellOpened: string[]
  applicationMenus: unknown[]
  builtTemplates: unknown[]
  aboutPanels: unknown[]
  clipboardText: string
  clipboardWrites: string[]
  exposed: Record<string, unknown>
  ipcInvoke: ((channel: string, ...args: unknown[]) => Promise<unknown>) | null
  ipcListeners: Array<{ channel: string; wrapped: (...args: unknown[]) => void }>
  ipcMainListeners: Map<string, Array<(event: unknown, ...args: unknown[]) => void>>
  ipcHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  ipcHandles: string[]
  viewBuilder: ((options: unknown) => unknown) | null
  windowBuilder: ((options: unknown) => unknown) | null
  exitCode: number
  quitCalls: number
  shouldUseDarkColors: boolean
  appEmitter: EventEmitter
}

export const electronMockState: ElectronMockState = {
  whenReady: Promise.resolve(),
  userDataPath: "/tmp/synergy-desktop-test",
  displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  permissionRequestHandlers: [],
  shellOpened: [],
  applicationMenus: [],
  builtTemplates: [],
  aboutPanels: [],
  clipboardText: "clipboard-text",
  clipboardWrites: [],
  exposed: {},
  ipcInvoke: null,
  ipcListeners: [],
  ipcMainListeners: new Map(),
  ipcHandlers: new Map(),
  ipcHandles: [],
  viewBuilder: null,
  windowBuilder: null,
  exitCode: 0,
  quitCalls: 0,
  shouldUseDarkColors: true,
  appEmitter: electronAppEmitter,
}

export const app = Object.assign(electronAppEmitter, {
  isPackaged: false,
  whenReady: () => electronMockState.whenReady,
  quit: () => {
    electronMockState.quitCalls++
  },
  exit: (code: number) => {
    electronMockState.exitCode = code
  },
  setAppUserModelId: () => {},
  requestSingleInstanceLock: () => true,
  getVersion: () => "1.1.26",
  getPath: (_name: string) => electronMockState.userDataPath,
  setAboutPanelOptions: (options: unknown) => {
    electronMockState.aboutPanels.push(options)
  },
  setAsDefaultProtocolClient: () => {},
  setBadgeCount: () => {},
  dock: { setBadge: () => {}, setIcon: () => {} },
})

function sharedWebContentsView(options: unknown): unknown {
  const builder = electronMockState.viewBuilder
  if (!builder) throw new Error("electron mock WebContentsView builder is not configured")
  return builder(options)
}

function sharedBrowserWindow(options: unknown): unknown {
  const builder = electronMockState.windowBuilder
  if (!builder) throw new Error("electron mock BrowserWindow builder is not configured")
  return builder(options)
}

export const electronMock = {
  app,
  BrowserWindow: sharedBrowserWindow,
  WebContentsView: sharedWebContentsView,
  nativeTheme: {
    get shouldUseDarkColors() {
      return electronMockState.shouldUseDarkColors
    },
    themeSource: "system",
    on: () => {},
  },
  screen: {
    getAllDisplays: () => electronMockState.displays,
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler(
        handler: (webContents: unknown, permission: unknown, callback: (granted: boolean) => void) => void,
      ) {
        electronMockState.permissionRequestHandlers.push(handler)
      },
    },
  },
  shell: {
    openExternal: async (url: string) => {
      electronMockState.shellOpened.push(url)
    },
  },
  Menu: {
    setApplicationMenu(value: unknown) {
      electronMockState.applicationMenus.push(value)
    },
    buildFromTemplate(template: unknown) {
      electronMockState.builtTemplates.push(template)
      return { template }
    },
  },
  clipboard: {
    readText: () => electronMockState.clipboardText,
    writeText: (text: string) => {
      electronMockState.clipboardWrites.push(text)
    },
  },
  contextBridge: {
    exposeInMainWorld(key: string, value: unknown) {
      electronMockState.exposed[key] = value
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      if (!electronMockState.ipcInvoke) throw new Error(`Unexpected invoke ${channel}`)
      return electronMockState.ipcInvoke(channel, ...args)
    },
    on(channel: string, wrapped: (...args: unknown[]) => void) {
      electronMockState.ipcListeners.push({ channel, wrapped })
    },
    off(channel: string, wrapped: (...args: unknown[]) => void) {
      const index = electronMockState.ipcListeners.findIndex(
        (entry) => entry.channel === channel && entry.wrapped === wrapped,
      )
      if (index >= 0) electronMockState.ipcListeners.splice(index, 1)
    },
  },
  ipcMain: {
    on(channel: string, handler: (event: unknown, payload: unknown) => void) {
      const current = electronMockState.ipcMainListeners.get(channel) ?? []
      current.push(handler)
      electronMockState.ipcMainListeners.set(channel, current)
    },
    removeAllListeners(channel: string) {
      electronMockState.ipcMainListeners.delete(channel)
    },
    handle(channel: string) {
      electronMockState.ipcHandles.push(channel)
    },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
  Tray: class {
    setToolTip() {}
    setImage() {}
    setContextMenu() {}
    on() {}
  },
}

export function registerElectronMock(): void {
  mock.module("electron", () => electronMock)
}

// Shared BrowserWindow fixture used by the WebRTC host suite. Each test file
// assigns electronMockState.windowBuilder to a builder returning an instance
// of this class (or a subclass) before importing the real source modules.
export class MockElectronWindow extends EventEmitter {
  destroyed = false
  backgroundColor = ""
  menuBarVisible: boolean | null = null
  title = ""
  sizes: Array<{ width: number; height: number }> = []
  readonly webContents: MockElectronWebContents

  constructor(readonly options: Record<string, unknown>) {
    super()
    this.webContents = new MockElectronWebContents()
  }

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
  }

  setMenuBarVisibility(visible: boolean) {
    this.menuBarVisible = visible
  }

  async loadURL(url: string) {
    this.webContents.url = url
  }

  async loadFile(path: string) {
    this.webContents.url = path
  }

  setBackgroundColor(color: string) {
    this.backgroundColor = color
  }

  setTitle(title: string) {
    this.title = title
  }

  setSize(width: number, height: number) {
    this.sizes.push({ width, height })
  }
}

export class MockElectronWebContents extends EventEmitter {
  destroyed = false
  url = "about:blank"
  title = ""
  loading = false
  sent: Array<{ channel: string; payload: unknown }> = []
  readonly session = {
    setProxy: async () => undefined,
    setPermissionCheckHandler(_handler: unknown) {},
    setPermissionRequestHandler(_handler: unknown) {},
    setDisplayMediaRequestHandler(_handler: unknown) {},
  }
  readonly mainFrame = { id: "frame-1" }

  isDestroyed() {
    return this.destroyed
  }

  setWindowOpenHandler(_handler: unknown) {}

  async loadURL(url: string) {
    this.url = url
  }

  async loadFile(path: string) {
    this.url = path
  }

  getURL() {
    return this.url
  }

  getTitle() {
    return this.title
  }

  isLoading() {
    return this.loading
  }

  send(channel: string, payload: unknown) {
    this.sent.push({ channel, payload })
  }

  async executeJavaScript(_code: string) {
    return undefined
  }
}

export function resetElectronMockState(): void {
  electronMockState.whenReady = Promise.resolve()
  electronMockState.userDataPath = "/tmp/synergy-desktop-test"
  electronMockState.displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
  electronMockState.permissionRequestHandlers = []
  electronMockState.shellOpened = []
  electronMockState.applicationMenus = []
  electronMockState.builtTemplates = []
  electronMockState.aboutPanels = []
  electronMockState.clipboardText = "clipboard-text"
  electronMockState.clipboardWrites = []
  electronMockState.exposed = {}
  electronMockState.ipcInvoke = null
  electronMockState.ipcListeners = []
  electronMockState.ipcMainListeners = new Map()
  electronMockState.ipcHandles = []
  electronMockState.viewBuilder = null
  electronMockState.windowBuilder = null
  electronMockState.exitCode = 0
  electronMockState.quitCalls = 0
  electronMockState.shouldUseDarkColors = true
  electronAppEmitter.removeAllListeners()
}
