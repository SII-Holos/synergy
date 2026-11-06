import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { preview } from "../../src/execution/preview"

test.each([
  ["empty", ""],
  ["short", "already compact"],
  ["whitespace", " \t\r\nhello\n\nworld\t "],
  ["unicode whitespace", "\u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000\ufeffend"],
  ["non-whitespace controls", "a\u0085b\u200bc"],
  ["long", "abcdef".repeat(100)],
  ["leading whitespace", "\t\n ".repeat(1000) + "content"],
  ["only whitespace", "\t\n ".repeat(1000)],
  ["whitespace boundary", "x".repeat(239) + "\t\n end"],
  ["surrogate boundary", "x".repeat(239) + "😀end"],
  ["unpaired surrogates", "\ud800value\udc00"],
])("execution preview preserves whitespace and UTF-16 truncation for %s text", (_name, value) => {
  expect(preview(value)).toBe(value.replace(/\s+/g, " ").slice(0, 240))
})

test.each(["latin", "utf16"])("retained execution previews release large %s source strings", (kind) => {
  const fixture = new URL("../fixtures/execution-preview-memory.ts", import.meta.url)
  const child = Bun.spawnSync([process.execPath, fileURLToPath(fixture), kind], { timeout: 10_000 })
  expect(child.exitCode).toBe(0)
  const result = JSON.parse(new TextDecoder().decode(child.stdout)) as {
    retainedBytes: number
    previewChars: number
  }
  expect(result.previewChars).toBe(32 * 240)
  expect(result.retainedBytes).toBeLessThan(4 * 1024 * 1024)
})
