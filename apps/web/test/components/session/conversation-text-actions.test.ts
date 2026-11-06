import { expect, test } from "bun:test"
import { createConversationTextActions } from "../../../src/components/session/conversation-text-actions"

test("copy and export share a pending canonical read and retain the original session intent", async () => {
  let sessionID = "ses_original"
  const pending = Promise.withResolvers<string>()
  const reads: string[] = []
  const copied: string[] = []
  const exported: { text: string; filename: string }[] = []
  const actions = createConversationTextActions({
    selection: () => ({ sessionID, title: "../中文/history" }),
    read: (id) => {
      reads.push(id)
      return pending.promise
    },
    copy: async (text) => {
      copied.push(text)
      return true
    },
    download: (text, filename) => {
      exported.push({ text, filename })
    },
  })
  const copy = actions.copy()
  const download = actions.export()
  sessionID = "ses_new"
  const text = "unmounted earlier history\n" + "完整中文原文\n".repeat(1000)
  pending.resolve(text)
  expect(await copy).toBe(true)
  expect(await download).toBe(true)
  expect(reads).toEqual(["ses_original"])
  expect(copied).toEqual([text])
  expect(exported).toEqual([{ text, filename: ".._中文_history.txt" }])
})

test("a failed canonical read permits a fresh retry and never publishes incomplete text", async () => {
  let failing = true
  const copied: string[] = []
  const actions = createConversationTextActions({
    selection: () => ({ sessionID: "ses_one", title: "Conversation" }),
    read: async () => {
      if (failing) throw new Error("unavailable")
      return "complete"
    },
    copy: async (text) => {
      copied.push(text)
      return true
    },
    download: () => {
      throw new Error("unexpected export")
    },
  })
  await expect(actions.copy()).rejects.toThrow("unavailable")
  expect(copied).toEqual([])
  failing = false
  expect(await actions.copy()).toBe(true)
  expect(copied).toEqual(["complete"])
})

test("an empty selection or unsuccessful clipboard write does not report success", async () => {
  let sessionID: string | undefined
  const actions = createConversationTextActions({
    selection: () => ({ sessionID }),
    read: async () => "original",
    copy: async () => false,
    download: () => {
      throw new Error("unexpected export")
    },
  })
  expect(await actions.copy()).toBe(false)
  expect(await actions.export()).toBe(false)
  sessionID = "ses_one"
  expect(await actions.copy()).toBe(false)
})
