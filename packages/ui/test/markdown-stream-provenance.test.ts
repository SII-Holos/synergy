import { expect, test } from "bun:test"
import type * as StreamingMarkdown from "streaming-markdown"

for (const file of ["smd.js", "smd.min.js"]) {
  test(`${file} preserves consumed provenance through token replay and split chunks`, async () => {
    const api = (await import(`../node_modules/streaming-markdown/${file}`)) as typeof StreamingMarkdown
    for (const markdown of [
      "raw http://example.com/a trailing\n",
      "`a\nb`\n",
      "-\tfirst\n\tsecond **bold**\n",
      "> first\n> second\n",
      "[repeat](https://example.com) [repeat](https://example.com)\n",
      "$$x and x $$currency\n",
      "Escaped \\*literal\\* and `code`\n",
      "👩‍🔬 🇨🇳 é text\n",
      "```ts\nconst value=42\n```\n",
      "|head|value|\n|---|---|\n|cell|other|\n",
      "![alt](https://example.com/image.png)\n",
    ]) {
      const render = (tracked: boolean) => {
        const output: Array<{ kind: string; value: string | number }> = []
        const parser = api.parser({
          track_source: tracked,
          data: undefined,
          add_token(_, type, source) {
            output.push({ kind: "token", value: type })
            if (tracked && source !== undefined) expect(source).toBeGreaterThanOrEqual(0)
          },
          end_token() {
            output.push({ kind: "end", value: "" })
          },
          add_text(_, text, spans) {
            output.push({ kind: "text", value: text })
            if (!tracked) return
            expect(spans).toBeDefined()
            expect(spans!.reduce((length, span) => length + span.length, 0)).toBe(text.length)
            let offset = 0
            for (const span of spans!) {
              for (let index = 0; index < span.length; index++)
                if (span.source >= 0) expect(markdown[span.source + index]).toBe(text[offset + index])
              offset += span.length
            }
          },
          set_attr(_, type, value) {
            output.push({ kind: `attr-${type}`, value })
          },
        })
        for (let offset = 0; offset < markdown.length; offset += 3)
          api.parser_write(parser, markdown.slice(offset, offset + 3))
        api.parser_end(parser)
        return output
      }
      expect(render(true)).toEqual(render(false))
    }
  })
}
