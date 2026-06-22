import { Show } from "solid-js"
import { useBrowser, type ScreenshotEntry } from "./browser-store"

export function ScreenshotCanvas() {
  let imgRef: HTMLImageElement | undefined
  const { activeTabId, tabScreenshots, send } = useBrowser()

  const activeScreenshot = (): ScreenshotEntry | undefined => {
    const id = activeTabId()
    if (!id) return undefined
    return tabScreenshots[id]
  }

  const handleClick = (e: MouseEvent) => {
    const entry = activeScreenshot()
    if (!entry || !imgRef) return

    const displayedWidth = imgRef.clientWidth
    const displayedHeight = imgRef.clientHeight
    if (displayedWidth === 0 || displayedHeight === 0) return

    const rect = imgRef.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    const pageX = Math.round(clickX * (entry.width / displayedWidth))
    const pageY = Math.round(clickY * (entry.height / displayedHeight))

    send({ type: "click", x: pageX, y: pageY })
  }

  return (
    <div class="relative w-full h-full flex items-center justify-center bg-background-strong overflow-hidden">
      <Show
        when={activeScreenshot()}
        fallback={<span class="text-13 text-text-weak select-none">No screenshot available</span>}
      >
        {(entry) => (
          <img
            ref={imgRef}
            src={entry().url}
            alt="Browser screenshot"
            class="max-w-full max-h-full object-contain cursor-crosshair"
            onClick={handleClick}
          />
        )}
      </Show>
    </div>
  )
}
