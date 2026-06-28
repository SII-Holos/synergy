import { Show } from "solid-js"
import { useBrowser, type ScreenshotEntry } from "./browser-store"

export function ScreenshotCanvas() {
  let wrapperRef: HTMLDivElement | undefined
  let imgRef: HTMLImageElement | undefined
  const { pageId: currentPageId, pageScreenshots, annotationMode, setAnnotationTarget, send } = useBrowser()

  const activeScreenshot = (): ScreenshotEntry | undefined => {
    const id = currentPageId()
    if (!id) return undefined
    return pageScreenshots[id]
  }

  const handleClick = (e: MouseEvent) => {
    const entry = activeScreenshot()
    if (!entry || !imgRef) return

    const displayedWidth = imgRef.clientWidth
    const displayedHeight = imgRef.clientHeight
    if (displayedWidth === 0 || displayedHeight === 0) return

    const imgRect = imgRef.getBoundingClientRect()
    const clickX = e.clientX - imgRect.left
    const clickY = e.clientY - imgRect.top

    const pageX = Math.round(clickX * (entry.width / displayedWidth))
    const pageY = Math.round(clickY * (entry.height / displayedHeight))

    if (annotationMode()) {
      const wrapperRect = wrapperRef!.getBoundingClientRect()
      setAnnotationTarget({
        displayX: Math.round(e.clientX - wrapperRect.left),
        displayY: Math.round(e.clientY - wrapperRect.top),
        pageX,
        pageY,
      })
    } else {
      send({ type: "click", pageId: currentPageId(), x: pageX, y: pageY })
    }
  }

  return (
    <div
      ref={wrapperRef}
      class="relative w-full h-full flex items-center justify-center bg-background-strong overflow-hidden"
    >
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
