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
      if (input.container.innerHTML.trim() !== input.html.trim()) {
        const template = input.container.ownerDocument.createElement("template")
        template.innerHTML = input.html
        const previous = [...input.container.children]
        let index = 0
        let cursor = input.container.firstChild
        for (const next of [...template.content.childNodes]) {
          const candidate = next.nodeType === 1 ? previous[index++] : undefined
          if (candidate?.isEqualNode(next)) {
            while (cursor && cursor !== candidate) {
              const removed = cursor
              cursor = cursor.nextSibling
              removed.remove()
            }
            cursor = candidate.nextSibling
          } else input.container.insertBefore(next, cursor)
        }
        while (cursor) {
          const removed = cursor
          cursor = cursor.nextSibling
          removed.remove()
        }
      }
      current = { hash: input.hash, cleanup: input.enhance?.(input.container) }
      return true
    },
    reset() {
      current?.cleanup?.()
      current = undefined
    },
  }
}
