import { expect, test } from "bun:test"
import { InputAssistance } from "@ericsanchezok/synergy-util/input-assistance"
import { original, sketch, diversify } from "../src/evidence"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"

function message(text: string, metadata?: Record<string, unknown>) {
  const info: MessageV2.User = {
    id: "m",
    sessionID: "s",
    role: "user",
    isRoot: true,
    time: { created: 1 },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    origin: { type: "user" },
    metadata,
  }
  return { info, parts: [{ id: "p", sessionID: "s", messageID: "m", type: "text" as const, text }] }
}

test("voice evidence preserves original code-switching and rejects assisted or other-authored material", () => {
  expect(original(message("先把 API 边界讲清楚，再写代码"))).toBe("先把 API 边界讲清楚，再写代码")
  expect(
    original(
      message("先写测试", {
        assistance: InputAssistance.accept(undefined, {
          producer: "test",
          proposalID: "p",
          generated: "先写测试",
          accepted: "先写测试",
        }),
      }),
    ),
  ).toBeUndefined()
  expect(original(message(" чужой голос", { author: { name: "other" } }))).toBeUndefined()
  expect(original(message("```ts\nconst password = 1\n```"))).toBeUndefined()
  expect(original(message("⟦sec:secret⟧"))).toBeUndefined()
  const system = message("generated")
  system.parts[0] = { ...system.parts[0], origin: "system" } as MessageV2.TextPart
  expect(original(system)).toBeUndefined()
  expect(sketch(["短句？", "API 要测试。"])).toMatchObject({ count: 2, questions: 1 })
})

test("evidence diversity cannot amplify identical utterances or copied families", () => {
  const items = [
    { text: "先测试", family: "one", score: 10 },
    { text: "先测试！", family: "two", score: 9 },
    { text: "不同话", family: "one", score: 8 },
    { text: "新的表达", family: "three", score: 7 },
  ]
  expect(diversify(items, 3, 1).map((item) => item.text)).toEqual(["先测试", "新的表达"])
})
