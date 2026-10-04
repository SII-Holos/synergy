import { createMarkdownParser } from "./markdown-parser"
import { parseMarkdownDocument } from "./markdown-document"
import { useMarkdownMathMarker } from "./marked-math"

const parser = createMarkdownParser()
const jobs = new Map<number, { markdown: string; blocks?: boolean; inline?: boolean; mathMarker?: string }>()
let running = false
async function run() {
  if (running) return
  running = true
  try {
    for (const [id, job] of jobs) {
      try {
        if (job.mathMarker) useMarkdownMathMarker(job.mathMarker)
        const result = job.blocks
          ? { document: await parseMarkdownDocument(parser, job.markdown, () => !jobs.has(id)) }
          : { html: await (job.inline ? parser.parseInline(job.markdown) : parser.parse(job.markdown)) }
        if (jobs.has(id)) self.postMessage({ id, ...result })
      } catch (error) {
        if (jobs.has(id)) self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
      } finally {
        jobs.delete(id)
      }
    }
  } finally {
    running = false
  }
}
self.onmessage = (
  event: MessageEvent<{
    id: number
    markdown?: string
    cancel?: boolean
    blocks?: boolean
    inline?: boolean
    mathMarker?: string
  }>,
) => {
  const message = event.data
  if (message.cancel) jobs.delete(message.id)
  else if (typeof message.markdown === "string") {
    jobs.set(message.id, {
      markdown: message.markdown,
      blocks: message.blocks,
      inline: message.inline,
      mathMarker: message.mathMarker,
    })
    void run()
  }
}
