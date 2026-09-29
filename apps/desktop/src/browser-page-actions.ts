import {
  BrowserPageActionSchema,
  type BrowserPageAction,
  type BrowserPageActionResult,
} from "@ericsanchezok/synergy-browser-core"
export { browserShortcut } from "@ericsanchezok/synergy-browser-core"

// Native operations follow Electron's webContents contract: https://www.electronjs.org/docs/latest/api/web-contents
export async function runBrowserPageAction(
  contents: Electron.WebContents,
  input: BrowserPageAction,
  savePDF?: (data: Buffer) => Promise<boolean>,
): Promise<BrowserPageActionResult> {
  const action = BrowserPageActionSchema.parse(input)
  switch (action.type) {
    case "capture":
      throw new Error("Capture requires the native page controller.")
    case "state":
      return {
        type: "state",
        back: contents.navigationHistory.canGoBack(),
        forward: contents.navigationHistory.canGoForward(),
        zoom: contents.getZoomFactor(),
      }
    case "zoom":
      contents.setZoomFactor(action.factor)
      return { type: "zoom", factor: contents.getZoomFactor() }
    case "stopFind":
      contents.stopFindInPage("clearSelection")
      return { type: "done" }
    case "find":
      return new Promise((resolve, reject) => {
        let requestId = -1
        const cleanup = () => {
          clearTimeout(timer)
          contents.off("found-in-page", found)
          contents.off("destroyed", destroyed)
        }
        const destroyed = () => {
          cleanup()
          reject(new Error("Page was closed. Open it again to search."))
        }
        const found = (_event: Electron.Event, result: Electron.Result) => {
          if (result.requestId !== requestId || !result.finalUpdate) return
          cleanup()
          resolve({ type: "find", matches: result.matches, active: result.activeMatchOrdinal })
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error("Page search timed out. Retry."))
        }, 5_000)
        contents.on("found-in-page", found)
        contents.once("destroyed", destroyed)
        try {
          requestId = contents.findInPage(action.text, { forward: action.forward, findNext: !action.next })
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    case "print":
      return new Promise((resolve, reject) =>
        contents.print({}, (success, reason) => {
          if (success) resolve({ type: "done" })
          else if (reason === "cancelled") resolve({ type: "done", cancelled: true })
          else reject(new Error(reason || "Printing failed."))
        }),
      )
    case "pdf": {
      if (!savePDF) throw new Error("Saving PDF is unavailable.")
      const data = await contents.printToPDF({ printBackground: true })
      return { type: "done", cancelled: !(await savePDF(data)) }
    }
  }
}
