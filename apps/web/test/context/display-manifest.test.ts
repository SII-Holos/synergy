import { expect, test } from "bun:test"
import { validateDisplayManifest } from "../../src/context/display-manifest"

test("validates every loaded message in bounded batches and repairs only changes", async () => {
  const messages = Array.from({ length: 251 }, (_, index) => ({ messageID: `m${index}`, version: "v", generation: 4 }))
  const batches: number[] = []
  const changed: string[] = []
  const result = await validateDisplayManifest({
    messages,
    signal: new AbortController().signal,
    current: () => true,
    read: async (batch) => {
      batches.push(batch.length)
      return {
        messages: batch.map((message) => ({
          ...message,
          status: message.messageID === "m203" ? ("changed" as const) : ("unchanged" as const),
          generation: message.messageID === "m203" ? 5 : 4,
        })),
      }
    },
    accept: async (message) => {
      if (message.status === "changed") changed.push(message.messageID)
    },
  })
  expect(batches).toEqual([100, 100, 51])
  expect(changed).toEqual(["m203"])
  expect(result).toBe(true)
})

test("a replaced owner cannot accept a delayed validation or start the next batch", async () => {
  let current = true
  const pending = Promise.withResolvers<{ messages: [] }>()
  let reads = 0
  let writes = 0
  const result = validateDisplayManifest({
    messages: Array.from({ length: 201 }, (_, index) => ({ messageID: `m${index}` })),
    signal: new AbortController().signal,
    current: () => current,
    read: () => {
      reads++
      return pending.promise
    },
    accept: async () => {
      writes++
    },
  })
  current = false
  pending.resolve({ messages: [] })
  expect(await result).toBe(false)
  expect(reads).toBe(1)
  expect(writes).toBe(0)
})

test("an incomplete authority response never marks a window validated", async () => {
  await expect(
    validateDisplayManifest({
      messages: [{ messageID: "m" }],
      signal: new AbortController().signal,
      current: () => true,
      read: async () => ({ messages: [] }),
      accept: async () => {},
    }),
  ).rejects.toThrow("Incomplete display manifest")
})
