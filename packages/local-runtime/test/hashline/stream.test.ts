import { describe, expect, test } from "bun:test"
import {
  formatHashlineHeader,
  formatHashlineBlock,
  formatNumberedLine,
  streamHashLines,
} from "../../src/hashline/index"

// ============================================================================
// streamHashLines — async iterator API
// ============================================================================
describe("streamHashLines", () => {
  test("generates hashline display lines with correct numbering", async () => {
    const content = "line1\nline2\nline3\n"
    const encoder = new TextEncoder()
    const chunks = [encoder.encode(content)]
    const source = (async function* () {
      for (const chunk of chunks) yield chunk
    })()
    const results: string[] = []
    for await (const chunk of streamHashLines(source)) {
      results.push(chunk)
    }
    const output = results.join("\n")
    expect(output).toContain("1:line1")
    expect(output).toContain("2:line2")
    expect(output).toContain("3:line3")
  })

  test("handles empty file content", async () => {
    const source = (async function* () {
      // empty — no chunks
    })()
    const results: string[] = []
    for await (const chunk of streamHashLines(source)) {
      results.push(chunk)
    }
    expect(results.join("")).toBe("1:")
  })

  test("handles trailing newline correctly", async () => {
    const encoder = new TextEncoder()
    const chunks = [encoder.encode("a\n")]
    const source = (async function* () {
      for (const chunk of chunks) yield chunk
    })()
    const results: string[] = []
    for await (const chunk of streamHashLines(source)) {
      results.push(chunk)
    }
    const output = results.join("")
    expect(output).toBe("1:a")
  })

  test("handles content without trailing newline", async () => {
    const encoder = new TextEncoder()
    const chunks = [encoder.encode("a\nb")]
    const source = (async function* () {
      for (const chunk of chunks) yield chunk
    })()
    const results: string[] = []
    for await (const chunk of streamHashLines(source)) {
      results.push(chunk)
    }
    const output = results.join("\n")
    expect(output).toContain("1:a")
    expect(output).toContain("2:b")
  })
})
