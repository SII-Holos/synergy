import { expect, test } from "bun:test"
import { ExecutionJson } from "../../src/execution/json-sections"

async function* chunks(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text)
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size)
}

test("JSON sections retain real paths, message roles and exact UTF-8 byte ranges", async () => {
  const text = JSON.stringify({
    messages: [
      { role: "system", content: '指令\\"中文' },
      { role: "user", content: "问题" },
    ],
    tools: [{ name: "read", parameters: {} }],
    temperature: 0,
  })
  const result = await ExecutionJson.index(chunks(text))
  const section = result.items.find((item) => JSON.stringify(item.path) === JSON.stringify(["messages", "1"]))!
  expect(section.role).toBe("user")
  const bytes = Buffer.from(text).subarray(section.offset, section.offset + section.bytes)
  expect(JSON.parse(bytes.toString())).toEqual({ role: "user", content: "问题" })
  expect(result.items.some((item) => item.path[0] === "tools")).toBe(true)
})

test("large strings are indexed without retaining their body", async () => {
  const result = await ExecutionJson.index(
    chunks(JSON.stringify({ messages: [{ role: "user", content: "中".repeat(7_000_000) }] }), 65_536),
  )
  const section = result.items.find((item) => item.path[0] === "messages" && item.path.length === 2)!
  expect(section.bytes).toBeGreaterThan(20_000_000)
  expect(JSON.stringify(result).length).toBeLessThan(2000)
}, 30_000)

test.each(['{"x":', '{"x":1,}', "[1,]", '{"x":01}', '{"x":"\\q"}', "{}{}"])(
  "invalid JSON does not claim complete structured sections: %s",
  async (text) => {
    await expect(ExecutionJson.index(chunks(text))).rejects.toThrow()
  },
)
