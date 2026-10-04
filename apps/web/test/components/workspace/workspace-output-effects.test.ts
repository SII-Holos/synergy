import { afterEach, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Message, ToolPart } from "@ericsanchezok/synergy-sdk"

const [messages, setMessages] = createSignal<Message[]>([])
const [parts, setParts] = createSignal<ToolPart[]>([])
const revealed: unknown[] = []
const params = { id: "current" }
mock.module("@solidjs/router", () => ({ useParams: () => params }))
mock.module("@/context/sdk", () => ({ useSDK: () => ({ scopeID: "project" }) }))
mock.module("@/context/workbench", () => ({
  useWorkbenchPanels: () => ({ revealOutput: (value: unknown) => revealed.push(value) }),
}))
mock.module("@ericsanchezok/synergy-ui/context", () => ({
  useData: () => ({
    view: { messagesFor: () => messages(), partsFor: (id: string) => parts().filter((part) => part.messageID === id) },
  }),
}))
const { WorkspaceOutputEffects } = await import("../../../src/components/workspace/workspace-output-effects")
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  setMessages([])
  setParts([])
  revealed.length = 0
})

test("tool outputs are observed in assistant messages outside the user-only turn projection", async () => {
  const message = { id: "assistant", sessionID: "current", role: "assistant", time: { created: 100 } } as Message
  setMessages([{ id: "user", sessionID: "current", role: "user", time: { created: 99 } } as Message, message])
  createRoot((stop) => {
    dispose = stop
    WorkspaceOutputEffects()
  })
  await Promise.resolve()
  expect(revealed).toEqual([])
  setParts([
    {
      id: "output",
      messageID: "assistant",
      sessionID: "current",
      type: "tool",
      callID: "call",
      tool: "note_write",
      state: {
        status: "completed",
        input: {},
        title: "Note",
        output: "created",
        metadata: { action: "create", id: "note" },
        time: { start: 100, end: 101 },
      },
    },
  ])
  expect(revealed).toEqual([
    expect.objectContaining({
      sessionID: "current",
      panelId: "notes",
      init: { resourceId: "note", source: "project", title: undefined },
    }),
  ])
})

test("a background session output cannot reveal into the current session", async () => {
  setMessages([{ id: "background", sessionID: "other", role: "assistant", time: { created: 100 } } as Message])
  setParts([
    {
      id: "output",
      messageID: "background",
      sessionID: "other",
      type: "tool",
      callID: "call",
      tool: "note_write",
      state: {
        status: "completed",
        input: {},
        title: "Note",
        output: "created",
        metadata: { action: "create", id: "note" },
        time: { start: 100, end: 101 },
      },
    },
  ])
  createRoot((stop) => {
    dispose = stop
    WorkspaceOutputEffects()
  })
  await Promise.resolve()
  expect(revealed).toEqual([])
})
