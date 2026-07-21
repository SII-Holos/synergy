import * as smd from "streaming-markdown"

const allowedProtocols = new Set(["http:", "https:", "mailto:", "tel:"])
const relativeUrlBase = "https://synergy.invalid/"

function isSafeUrl(value: string) {
  try {
    return allowedProtocols.has(new URL(value, relativeUrlBase).protocol)
  } catch {
    return false
  }
}

function createSafeRenderer(root: HTMLElement): smd.Default_Renderer {
  const renderer = smd.default_renderer(root)
  return {
    ...renderer,
    set_attr(data, type, value) {
      if ((type === smd.HREF || type === smd.SRC) && !isSafeUrl(value)) return
      smd.default_set_attr(data, type, value)
      if (type !== smd.HREF) return
      data.nodes[data.index]?.setAttribute("rel", "noopener noreferrer")
    },
  }
}

export interface MarkdownStreamController {
  update(snapshot: string, key?: string): void
  end(): void
}

export function createMarkdownStreamController(root: HTMLElement): MarkdownStreamController {
  let parser!: smd.Parser
  let offset = 0
  let ended = false
  let hasUpdate = false
  let key: string | undefined

  const reset = () => {
    root.replaceChildren()
    parser = smd.parser(createSafeRenderer(root))
    offset = 0
    ended = false
  }

  reset()

  return {
    update(snapshot, nextKey) {
      if (ended || snapshot.length < offset || (hasUpdate && key !== nextKey)) reset()
      hasUpdate = true
      key = nextKey
      const delta = snapshot.slice(offset)
      offset = snapshot.length
      if (delta) smd.parser_write(parser, delta)
    },
    end() {
      if (ended) return
      ended = true
      try {
        smd.parser_end(parser)
      } catch {
        return
      }
    },
  }
}
