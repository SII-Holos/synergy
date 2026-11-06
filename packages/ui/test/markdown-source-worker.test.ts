import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("source provenance loads and normalizes entities in a browser worker without document", async () => {
  const source = pathToFileURL(path.resolve(import.meta.dir, "../src/context/markdown-source.ts")).href
  const script = `
    if ("document" in globalThis) throw new Error("The worker must have no document")
    const { markdownTextReadingSpans } = await import(${JSON.stringify(source)})
    const input = "&copy; &#x1f600; &NotEqualTilde; &unknown;"
    const spans = markdownTextReadingSpans(input, [{ source: 10, offset: 0, length: input.length }])
    if (spans.at(-1).offset + spans.at(-1).length !== "© 😀 ≂̸ &unknown;".length)
      throw new Error("Worker entity normalization differs from the canonical content")
    if (spans[0].source !== 10 || spans[0].sourceLength !== 6)
      throw new Error("Worker entity normalization lost consumed source provenance")
  `
  const worker = Bun.spawn([process.execPath, "--conditions=browser", "--eval", script], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, diagnostics] = await Promise.all([worker.exited, new Response(worker.stderr).text()])
  expect(status, diagnostics).toBe(0)
})
