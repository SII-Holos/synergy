export interface MarkdownTerminalTransitionInput {
  container: HTMLElement
  html: string
  hash: string
  enhance?: (root: HTMLElement) => () => void
}

export function createMarkdownTerminalTransitionController() {
  let current: { hash: string; cleanup: (() => void) | undefined } | undefined
  return {
    apply(input: MarkdownTerminalTransitionInput) {
      if (current?.hash === input.hash) return false
      current?.cleanup?.()
      if (input.container.innerHTML.trim() !== input.html.trim()) input.container.innerHTML = input.html
      current = { hash: input.hash, cleanup: input.enhance?.(input.container) }
      return true
    },
    reset() {
      current?.cleanup?.()
      current = undefined
    },
  }
}
