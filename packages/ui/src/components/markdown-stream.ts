import * as smd from "streaming-markdown"
import { createMarkdownStreamMotion } from "./markdown-stream-motion"

const allowedProtocols = new Set(["http:", "https:", "mailto:", "tel:"])
const relativeUrlBase = "https://synergy.invalid/"

function isSafeUrl(value: string) {
  try {
    return allowedProtocols.has(new URL(value, relativeUrlBase).protocol)
  } catch {
    return false
  }
}

function createSafeRenderer(
  root: HTMLElement,
  motion: ReturnType<typeof createMarkdownStreamMotion>,
): smd.Default_Renderer {
  const renderer = smd.default_renderer(root)
  return {
    ...renderer,
    add_text(data, text) {
      motion.append(data.nodes[data.index], text)
    },
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
  let motion: ReturnType<typeof createMarkdownStreamMotion>

  const reset = () => {
    motion?.dispose()
    motion = createMarkdownStreamMotion(root)
    root.replaceChildren()
    parser = smd.parser(createSafeRenderer(root, motion))
    offset = 0
    ended = false
  }

  reset()

  return {
    update(snapshot, nextKey) {
      const restart = ended || snapshot.length < offset || (hasUpdate && key !== nextKey)
      if (restart) reset()
      motion.begin(hasUpdate && !restart)
      hasUpdate = true
      key = nextKey
      const delta = snapshot.slice(offset)
      offset = snapshot.length
      if (delta) smd.parser_write(parser, delta)
      motion.play()
    },
    end() {
      if (ended) return
      ended = true
      motion.begin(false)
      try {
        smd.parser_end(parser)
      } catch {
        return
      } finally {
        motion.dispose()
      }
    },
  }
}
