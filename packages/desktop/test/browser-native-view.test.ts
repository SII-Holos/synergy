import { describe, expect, test } from "bun:test"
import type { BrowserNativeAttachRequest } from "@ericsanchezok/synergy-browser"

const { BrowserNativeViewManager } = await import("../src/browser-native-view.js")

describe("Browser native view manager", () => {
  test("updates visibility without detaching or recreating the native page", async () => {
    const visibility: boolean[] = []
    let attachCount = 0
    let detachCount = 0
    let bounds = { x: 0, y: 0, width: 1, height: 1 }
    const view = {
      webContents: {
        focus() {},
        getTitle: () => "",
        getURL: () => "about:blank",
        on() {},
        off() {},
      },
      setBounds(next: typeof bounds) {
        bounds = next
      },
      setVisible(visible: boolean) {
        visibility.push(visible)
      },
    }
    const pool = {
      attach() {
        attachCount += 1
        return view
      },
      detach() {
        detachCount += 1
      },
    }
    const manager = new BrowserNativeViewManager(
      { webContents: { getZoomFactor: () => 1 } } as never,
      pool as never,
      () => {},
    )
    const hiddenRequest: BrowserNativeAttachRequest & { visible: boolean } = {
      protocolVersion: 2,
      ownerKey: "scope:test:session:test",
      pageId: "page-test",
      bounds: { x: 12, y: 24, width: 640, height: 480 },
      visible: false,
    }

    await manager.attach(hiddenRequest)
    await manager.attach({ ...hiddenRequest, bounds: undefined, visible: true })

    expect(visibility).toEqual([false, true])
    expect(bounds).toEqual({ x: 12, y: 24, width: 640, height: 480 })
    expect(attachCount).toBe(1)
    expect(detachCount).toBe(0)
  })

  test("defaults older attach requests to visible", async () => {
    const visibility: boolean[] = []
    const view = {
      webContents: {
        focus() {},
        getTitle: () => "",
        getURL: () => "about:blank",
        on() {},
        off() {},
      },
      setBounds() {},
      setVisible(visible: boolean) {
        visibility.push(visible)
      },
    }
    const pool = {
      attach: () => view,
      detach() {},
    }
    const manager = new BrowserNativeViewManager(
      { webContents: { getZoomFactor: () => 1 } } as never,
      pool as never,
      () => {},
    )

    await manager.attach({
      protocolVersion: 2,
      ownerKey: "scope:test:session:test",
      pageId: "page-test",
    })

    expect(visibility).toEqual([true])
  })

  test("atomically swaps an attached view when the page slot replaces its generation", async () => {
    const operations: string[] = []
    let replacement: ((view: any, previous: any) => void) | undefined
    const makeView = (name: string) => ({
      webContents: {
        focus: () => operations.push(`focus:${name}`),
        isFocused: () => true,
        getTitle: () => "",
        getURL: () => "about:blank",
        on() {},
        off() {},
      },
      getBounds: () => ({ x: 12, y: 24, width: 640, height: 480 }),
      setBounds: () => operations.push(`bounds:${name}`),
      getVisible: () => true,
      setVisible: () => operations.push(`visible:${name}`),
    })
    const first = makeView("first")
    const second = makeView("second")
    const window = {
      contentView: {
        addChildView(view: unknown) {
          operations.push(view === first ? "add:first" : "add:second")
        },
        removeChildView(view: unknown) {
          operations.push(view === first ? "remove:first" : "remove:second")
        },
      },
    }
    const pool = {
      attach: () => {
        window.contentView.addChildView(first)
        return first
      },
      detach() {},
      onGeneration(_ownerKey: string, _pageId: string, listener: typeof replacement) {
        replacement = listener
        return () => undefined
      },
    }
    const manager = new BrowserNativeViewManager(
      { webContents: { getZoomFactor: () => 1 }, contentView: window.contentView } as never,
      pool as never,
      () => {},
    )
    await manager.attach({
      protocolVersion: 2,
      ownerKey: "scope:test:session:generation",
      pageId: "page-generation",
    })

    replacement?.(second, first)

    expect(operations).toContain("remove:first")
    expect(operations).toContain("add:second")
    expect(operations).toContain("bounds:second")
    expect(operations).toContain("visible:second")
    expect(operations).toContain("focus:second")
  })
})
