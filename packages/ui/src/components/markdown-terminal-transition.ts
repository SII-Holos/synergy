export const MARKDOWN_TERMINAL_CROSSFADE_MS = 280
export const MARKDOWN_TERMINAL_CROSSFADE_MAX_CHARS = 20_000

export type MarkdownTerminalTransitionMode = "instant" | "crossfade"

export function markdownTerminalTransitionMode(input: {
  hadStreamContent: boolean
  markdownLength: number
  prefersReducedMotion: boolean
}): MarkdownTerminalTransitionMode {
  if (!input.hadStreamContent) return "instant"
  if (input.prefersReducedMotion) return "instant"
  if (input.markdownLength > MARKDOWN_TERMINAL_CROSSFADE_MAX_CHARS) return "instant"
  return "crossfade"
}

export function applyMarkdownTerminalCrossfade(input: {
  container: HTMLElement
  html: string
  durationMs?: number
  enhance?: (root: HTMLElement) => () => void
  schedule?: (callback: () => void, ms: number) => number
  cancel?: (id: number) => void
  nextFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
  prefersReducedMotion?: boolean
  markdownLength?: number
  hadStreamContent?: boolean
}) {
  const mode = markdownTerminalTransitionMode({
    hadStreamContent: input.hadStreamContent ?? Boolean(input.container.childNodes.length),
    markdownLength: input.markdownLength ?? input.html.length,
    prefersReducedMotion: input.prefersReducedMotion ?? false,
  })

  const schedule = input.schedule ?? ((callback, ms) => window.setTimeout(callback, ms))
  const cancel = input.cancel ?? ((id) => window.clearTimeout(id))
  const nextFrame = input.nextFrame ?? ((callback) => window.requestAnimationFrame(callback))
  const cancelFrame = input.cancelFrame ?? ((id) => window.cancelAnimationFrame(id))
  const durationMs = input.durationMs ?? MARKDOWN_TERMINAL_CROSSFADE_MS

  let enhanceCleanup: (() => void) | undefined
  let timeoutId: number | undefined
  let frameId: number | undefined
  let finished = false

  const clearMotion = () => {
    if (timeoutId !== undefined) {
      cancel(timeoutId)
      timeoutId = undefined
    }
    if (frameId !== undefined) {
      cancelFrame(frameId)
      frameId = undefined
    }
  }

  const dispose = () => {
    clearMotion()
    enhanceCleanup?.()
    enhanceCleanup = undefined
  }

  if (mode === "instant") {
    input.container.replaceChildren()
    input.container.innerHTML = input.html
    enhanceCleanup = input.enhance?.(input.container)
    return dispose
  }

  const previous = document.createElement("div")
  previous.dataset.slot = "markdown-terminal-from"
  previous.replaceChildren(...Array.from(input.container.childNodes))
  previous.setAttribute("aria-hidden", "true")
  previous.inert = true

  const next = document.createElement("div")
  next.dataset.slot = "markdown-terminal-to"
  next.innerHTML = input.html

  const stage = document.createElement("div")
  stage.dataset.slot = "markdown-terminal-crossfade"
  stage.append(previous, next)
  input.container.replaceChildren(stage)

  // Bind interactive controls on the terminal layer while the short crossfade plays.
  // Moving these nodes into the container later preserves the same listeners.
  enhanceCleanup = input.enhance?.(next)

  frameId = nextFrame(() => {
    frameId = nextFrame(() => {
      frameId = undefined
      if (finished) return
      stage.dataset.active = "true"
      timeoutId = schedule(() => {
        timeoutId = undefined
        if (finished) return
        finished = true
        // Move the already-enhanced terminal nodes into place; do not re-parse HTML.
        input.container.replaceChildren(...Array.from(next.childNodes))
      }, durationMs)
    })
  })

  return () => {
    clearMotion()
    if (!finished) {
      finished = true
      input.container.replaceChildren(...Array.from(next.childNodes))
    }
    enhanceCleanup?.()
    enhanceCleanup = undefined
  }
}
