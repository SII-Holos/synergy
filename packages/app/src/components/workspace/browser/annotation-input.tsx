import { createSignal } from "solid-js"

interface Props {
  onSubmit: (comment: string, styleFeedback?: Record<string, string>) => void
  onCancel: () => void
}

export function AnnotationInput(props: Props) {
  const [comment, setComment] = createSignal("")
  const [showStyle, setShowStyle] = createSignal(false)
  const [fontSize, setFontSize] = createSignal("")
  const [color, setColor] = createSignal("")

  const handleSubmit = () => {
    const text = comment().trim()
    if (!text) return
    const style: Record<string, string> = {}
    if (fontSize()) style.fontSize = fontSize()
    if (color()) style.color = color()
    props.onSubmit(text, Object.keys(style).length > 0 ? style : undefined)
    setComment("")
  }

  return (
    <div class="absolute bottom-4 left-4 right-4 bg-surface-elevated rounded-lg border border-border p-3 shadow-lg z-50">
      <textarea
        class="w-full bg-transparent text-sm text-primary placeholder-secondary resize-none outline-none"
        rows={2}
        placeholder="Add a comment about this element..."
        value={comment()}
        onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)}
      />
      <div class="flex items-center justify-between mt-2">
        <button
          type="button"
          class="text-xs text-secondary hover:text-primary transition-colors"
          onClick={() => setShowStyle(!showStyle())}
        >
          {showStyle() ? "Hide style" : "Style feedback"}
        </button>
        <div class="flex gap-2">
          <button
            type="button"
            class="px-3 py-1 text-xs rounded-md bg-border/40 text-secondary hover:bg-border transition-colors"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="px-3 py-1 text-xs rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
            disabled={!comment().trim()}
            onClick={handleSubmit}
          >
            Send
          </button>
        </div>
      </div>
      {showStyle() && (
        <div class="flex gap-3 mt-2 pt-2 border-t border-border/50">
          <label class="flex items-center gap-1 text-xs text-secondary">
            Size
            <input
              type="text"
              class="w-16 px-1.5 py-0.5 bg-surface rounded border border-border text-xs"
              placeholder="14px"
              value={fontSize()}
              onInput={(e) => setFontSize((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="flex items-center gap-1 text-xs text-secondary">
            Color
            <input
              type="text"
              class="w-20 px-1.5 py-0.5 bg-surface rounded border border-border text-xs"
              placeholder="#3b82f6"
              value={color()}
              onInput={(e) => setColor((e.target as HTMLInputElement).value)}
            />
          </label>
        </div>
      )}
    </div>
  )
}
