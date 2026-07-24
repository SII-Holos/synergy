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
    const manager = new BrowserNativeViewManager({} as never, pool as never, () => {})
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
    const manager = new BrowserNativeViewManager({} as never, pool as never, () => {})

    await manager.attach({
      protocolVersion: 2,
      ownerKey: "scope:test:session:test",
      pageId: "page-test",
    })

    expect(visibility).toEqual([true])
  })
})
