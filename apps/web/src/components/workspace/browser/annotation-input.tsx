import { createSignal, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { browser as B } from "@/locales/messages"

interface Props {
  x: number
  y: number
  onSubmit: (comment: string, styleFeedback?: Record<string, string>) => void
  onCancel: () => void
}

export function AnnotationInput(props: Props) {
  const lingui = useLingui()
  const [comment, setComment] = createSignal("")
  const [showStyle, setShowStyle] = createSignal(false)
  const [fontSize, setFontSize] = createSignal("")
  const [color, setColor] = createSignal("")
  const [popupStyle, setPopupStyle] = createSignal<Record<string, string>>({})
  let textareaRef: HTMLTextAreaElement | undefined
  let popupRef: HTMLDivElement | undefined

  onMount(() => {
    textareaRef?.focus()
    computePosition()
  })

  const computePosition = () => {
    const popup = popupRef
    if (!popup) return

    // Measure after render so we can clamp
    requestAnimationFrame(() => {
      const rect = popup.getBoundingClientRect()
      const parent = popup.parentElement
      if (!parent) return

      const parentRect = parent.getBoundingClientRect()
      const popupW = rect.width
      const popupH = rect.height
      const padding = 12

      // Clamp x: prefer right of click, flip to left if overflow
      let left = props.x + 16
      if (left + popupW > parentRect.width - padding) {
        left = props.x - popupW - 16
      }
      if (left < padding) {
        left = padding
      }

      // Clamp y: prefer below click, flip to above if overflow
      let top = props.y + 16
      if (top + popupH > parentRect.height - padding) {
        top = props.y - popupH - 16
      }
      if (top < padding) {
        top = padding
      }

      setPopupStyle({
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
      })
    })
  }

  const handleSubmit = () => {
    const text = comment().trim()
    if (!text) return
    const style: Record<string, string> = {}
    if (fontSize()) style.fontSize = fontSize()
    if (color()) style.color = color()
    props.onSubmit(text, Object.keys(style).length > 0 ? style : undefined)
    setComment("")
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      props.onCancel()
    }
  }

  return (
    <>
      {/* Annotation pin — exact click position */}
      <div
        class="absolute z-50 pointer-events-none"
        style={{
          left: `${props.x}px`,
          top: `${props.y}px`,
          transform: "translate(-50%, -50%)",
        }}
      >
        <div class="relative">
          <div class="w-3 h-3 rounded-full bg-text-strong ring-2 ring-background-strong animate-pulse" />
          <div class="absolute inset-0 w-3 h-3 rounded-full bg-text-strong/30 animate-ping" />
        </div>
      </div>

      {/* Popup input */}
      <div
        ref={popupRef}
        class="workbench-popover-surface absolute z-50 w-72 rounded-lg border border-border-base/40 bg-surface-raised-stronger-non-alpha"
        style={popupStyle()}
        onKeyDown={handleKeyDown}
      >
        <div class="p-3 pb-2">
          <textarea
            ref={textareaRef}
            class="w-full resize-none bg-transparent text-sm text-text-base outline-none placeholder:text-text-weaker"
            rows={2}
            placeholder={lingui._(B.annotationPlaceholder.id)}
            value={comment()}
            onInput={(e) => {
              setComment((e.target as HTMLTextAreaElement).value)
              computePosition()
            }}
          />
        </div>

        <div class="flex items-center justify-between px-3 pb-2">
          <button
            type="button"
            class="text-xs text-text-weak transition-colors hover:text-text-strong"
            onClick={() => {
              setShowStyle(!showStyle())
              computePosition()
            }}
          >
            {showStyle() ? lingui._(B.hideStyle.id) : lingui._(B.styleFeedback.id)}
          </button>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-md bg-surface-inset-base px-3 py-1 text-xs text-text-base transition-colors hover:bg-surface-inset-base"
              onClick={props.onCancel}
            >
              {lingui._(B.cancel.id)}
            </button>
            <button
              type="button"
              class="rounded-md bg-text-strong px-3 py-1 text-xs text-background-base transition-colors hover:opacity-90 disabled:opacity-50"
              disabled={!comment().trim()}
              onClick={handleSubmit}
            >
              {lingui._(B.annotationSend.id)}
            </button>
          </div>
        </div>

        {showStyle() && (
          <div class="flex gap-3 border-t border-border-base/40 px-3 pb-3 pt-2">
            <label class="flex items-center gap-1 text-xs text-text-weak">
              {lingui._(B.size.id)}
              <input
                type="text"
                class="w-16 rounded border border-border-base/40 bg-input-base px-1.5 py-0.5 text-xs text-text-base"
                placeholder="14px"
                value={fontSize()}
                onInput={(e) => setFontSize((e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="flex items-center gap-1 text-xs text-text-weak">
              {lingui._(B.color.id)}
              <input
                type="text"
                class="w-20 rounded border border-border-base/40 bg-input-base px-1.5 py-0.5 text-xs text-text-base"
                placeholder="#3b82f6"
                value={color()}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>
        )}
      </div>

      {/* Backdrop to catch clicks outside */}
      <div
        class="absolute inset-0 z-40"
        onClick={(e) => {
          // Only cancel if clicking the backdrop itself, not the popup
          if (e.target === e.currentTarget) {
            props.onCancel()
          }
        }}
      />
    </>
  )
}
