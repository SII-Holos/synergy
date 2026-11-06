import { expect, test } from "bun:test"
import { canLeaveFileDocument } from "../../../src/context/file/close-policy"

test("file replacement negotiates save, discard and cancel against the captured draft", async () => {
  let draft: { content: string; revision: number } | undefined = { content: "Draft", revision: 1 }
  let choice: "save" | "discard" | "cancel" = "cancel"
  const protect = () =>
    canLeaveFileDocument({
      dirty: () => !!draft,
      draft: () => draft,
      choose: async () => choice,
      save: async (content) => {
        expect(content).toBe("Draft")
        draft = undefined
      },
      discard: () => {
        draft = undefined
      },
    })
  expect(await protect()).toBe(false)
  expect(draft?.content).toBe("Draft")
  choice = "save"
  expect(await protect()).toBe(true)
  draft = { content: "Next", revision: 2 }
  choice = "discard"
  expect(await protect()).toBe(true)
  expect(draft).toBeUndefined()
})

test("save failure and edits made while a protection dialog is open remain recoverable", async () => {
  let draft = { content: "Draft", revision: 1 }
  await expect(
    canLeaveFileDocument({
      dirty: () => true,
      draft: () => draft,
      choose: async () => "save",
      save: async () => {
        throw new Error("Conflict")
      },
      discard: () => {
        throw new Error("must retain")
      },
    }),
  ).rejects.toThrow("Conflict")
  expect(
    await canLeaveFileDocument({
      dirty: () => true,
      draft: () => draft,
      choose: async () => {
        draft = { content: "Later", revision: 2 }
        return "discard"
      },
      save: async () => {},
      discard: () => {
        throw new Error("must retain later edit")
      },
    }),
  ).toBe(false)
  expect(draft.content).toBe("Later")
})
