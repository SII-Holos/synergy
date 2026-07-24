import { describe, expect, test } from "bun:test"
import { sanitizeAttachmentHtml } from "../../../src/components/attachment-workbench/html"

describe("attachment HTML sanitization", () => {
  test("removes scripts, event handlers, forms, child frames, and embedded objects", () => {
    const sanitized = sanitizeAttachmentHtml(`
      <!doctype html>
      <html>
        <body onload="steal()">
          <script>steal()</script>
          <img onerror="steal()">
          <form><input name="secret"></form>
          <iframe></iframe>
          <object></object>
          <p>Safe content</p>
        </body>
      </html>
    `)

    expect(sanitized).toContain("Safe content")
    expect(sanitized).not.toContain("<script")
    expect(sanitized).not.toContain("onload")
    expect(sanitized).not.toContain("onerror")
    expect(sanitized).not.toContain("<form")
    expect(sanitized).not.toContain("<input")
    expect(sanitized).not.toContain("<iframe")
    expect(sanitized).not.toContain("<object")
  })
})
