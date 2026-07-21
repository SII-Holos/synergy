import { describe, expect, test } from "bun:test"
import { mapSelectDirectoryDialogResponse, selectDirectoryWithNativeDialog } from "../src/directory-picker.js"
import {
  parseBrowserNativeAttach,
  parseBrowserNativePage,
  parseBrowserNativeResize,
  parseDesktopBadgeState,
  parseClipboardWriteText,
  parseExternalUrl,
  parseSelectDirectoryDialogRequest,
  parseSelectDirectoryDialogResponse,
} from "../src/ipc-contract.js"

const managedRunningStatus = {
  mode: "managed" as const,
  state: "running" as const,
  url: "http://127.0.0.1:3000",
  port: 3000,
  pid: 123,
  lastError: null,
  logFile: null,
}

function mainWindowFixture() {
  const webContents = {}
  return {
    window: { webContents },
    webContents,
  }
}

describe("desktop ipc contract", () => {
  test("accepts valid browser native attach payloads", () => {
    expect(
      parseBrowserNativeAttach({
        protocolVersion: 2,
        ownerKey: "scope:scope:session:session",
        pageId: "page",
        bounds: { x: 0, y: 0, width: 640, height: 480 },
      }),
    ).toEqual({
      protocolVersion: 2,
      ownerKey: "scope:scope:session:session",
      pageId: "page",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    })
  })

  test("rejects malformed browser native payloads", () => {
    expect(() =>
      parseBrowserNativePage({ protocolVersion: 2, ownerKey: "scope:scope:session:session", pageId: "" }),
    ).toThrow()
    expect(() =>
      parseBrowserNativeResize({
        protocolVersion: 2,
        ownerKey: "scope:scope:session:session",
        pageId: "page",
        bounds: { width: -1, height: 1, x: 0, y: 0 },
      }),
    ).toThrow()
    expect(() =>
      parseBrowserNativeAttach({
        protocolVersion: 2,
        ownerKey: "scope:scope:session:session",
        pageId: "page",
        extra: true,
      }),
    ).toThrow()
    expect(() => parseBrowserNativeAttach({ pageId: "page" })).toThrow()
  })

  test("allows only safe external protocols", () => {
    expect(parseExternalUrl("https://example.com")).toBe("https://example.com")
    expect(parseExternalUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com")
    expect(() => parseExternalUrl("file:///etc/passwd")).toThrow()
    expect(() => parseExternalUrl("javascript:alert(1)")).toThrow()
  })

  test("accepts only string clipboard write payloads", () => {
    expect(parseClipboardWriteText("copy me")).toBe("copy me")
    expect(parseClipboardWriteText("")).toBe("")
    expect(() => parseClipboardWriteText({ text: "copy me" })).toThrow()
    expect(() => parseClipboardWriteText(null)).toThrow()
  })

  test("validates desktop badge counts", () => {
    expect(parseDesktopBadgeState({ count: 0 })).toEqual({ count: 0 })
    expect(parseDesktopBadgeState({ count: 12 })).toEqual({ count: 12 })
    expect(() => parseDesktopBadgeState({ count: -1 })).toThrow()
    expect(() => parseDesktopBadgeState({ count: 1.5 })).toThrow()
    expect(() => parseDesktopBadgeState({ count: 1, extra: true })).toThrow()
    expect(() => parseDesktopBadgeState(null)).toThrow()
  })

  test("validates native directory picker requests", () => {
    expect(parseSelectDirectoryDialogRequest({})).toEqual({ multiple: false })
    expect(parseSelectDirectoryDialogRequest({ title: "Add project", multiple: true })).toEqual({
      title: "Add project",
      multiple: true,
    })
    expect(() => parseSelectDirectoryDialogRequest({ title: "" })).toThrow()
    expect(() => parseSelectDirectoryDialogRequest({ title: "x".repeat(121) })).toThrow()
    expect(() => parseSelectDirectoryDialogRequest({ multiple: true, extra: true })).toThrow()
  })

  test("validates native directory picker responses", () => {
    expect(parseSelectDirectoryDialogResponse({ canceled: true, directoryPaths: [] })).toEqual({
      canceled: true,
      directoryPaths: [],
    })
    expect(parseSelectDirectoryDialogResponse({ canceled: false, directoryPaths: ["/repo"] })).toEqual({
      canceled: false,
      directoryPaths: ["/repo"],
    })
    expect(() => parseSelectDirectoryDialogResponse({ canceled: false, directoryPaths: [1] })).toThrow()
    expect(() => parseSelectDirectoryDialogResponse({ canceled: true, directoryPaths: ["/repo"] })).toThrow()
    expect(() => parseSelectDirectoryDialogResponse({ canceled: false, directoryPaths: [] })).toThrow()
  })

  test("authorizes native directory picker against sender and managed running server", async () => {
    const { window, webContents } = mainWindowFixture()
    const showOpenDialog = async () => ({ canceled: true, filePaths: [] })

    await expect(
      selectDirectoryWithNativeDialog({
        mainWindow: window as any,
        sender: {} as any,
        serverStatus: managedRunningStatus,
        showOpenDialog: showOpenDialog as any,
        rawRequest: {},
      }),
    ).rejects.toThrow("main desktop window")

    await expect(
      selectDirectoryWithNativeDialog({
        mainWindow: window as any,
        sender: webContents as any,
        serverStatus: { ...managedRunningStatus, mode: "external", state: "external" },
        showOpenDialog: showOpenDialog as any,
        rawRequest: {},
      }),
    ).rejects.toThrow("managed local server")

    await expect(
      selectDirectoryWithNativeDialog({
        mainWindow: window as any,
        sender: webContents as any,
        serverStatus: { ...managedRunningStatus, state: "starting" },
        showOpenDialog: showOpenDialog as any,
        rawRequest: {},
      }),
    ).rejects.toThrow("managed local server")
  })

  test("maps native directory picker dialog results", async () => {
    const { window, webContents } = mainWindowFixture()
    const cancel = await selectDirectoryWithNativeDialog({
      mainWindow: window as any,
      sender: webContents as any,
      serverStatus: managedRunningStatus,
      showOpenDialog: (async () => ({ canceled: true, filePaths: [] })) as any,
      rawRequest: {},
    })
    expect(cancel).toEqual({ canceled: true, directoryPaths: [] })

    const selected = await selectDirectoryWithNativeDialog({
      mainWindow: window as any,
      sender: webContents as any,
      serverStatus: managedRunningStatus,
      showOpenDialog: (async () => ({ canceled: false, filePaths: ["/repo-a", "/repo-b"] })) as any,
      rawRequest: { multiple: true },
    })
    expect(selected).toEqual({ canceled: false, directoryPaths: ["/repo-a", "/repo-b"] })

    await expect(
      selectDirectoryWithNativeDialog({
        mainWindow: window as any,
        sender: webContents as any,
        serverStatus: managedRunningStatus,
        showOpenDialog: (async () => ({ canceled: false, filePaths: ["/repo-a", "/repo-b"] })) as any,
        rawRequest: {},
      }),
    ).rejects.toThrow("multiple paths")
  })

  test("maps preload directory picker responses", () => {
    expect(mapSelectDirectoryDialogResponse({ canceled: true, directoryPaths: [] }, false)).toBeNull()
    expect(mapSelectDirectoryDialogResponse({ canceled: false, directoryPaths: ["/repo"] }, false)).toBe("/repo")
    expect(mapSelectDirectoryDialogResponse({ canceled: false, directoryPaths: ["/repo-a", "/repo-b"] }, true)).toEqual(
      ["/repo-a", "/repo-b"],
    )
  })
})
