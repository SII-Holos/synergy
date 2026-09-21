import { expect, test } from "bun:test"
import type { WebContents, IpcMainInvokeEvent } from "electron"
import { DesktopServerActions, trustedServerFrame } from "../src/server-ipc"

test("server actions reject child frames and arbitrary local pages before app readiness", () => {
  const frame = {
    processId: 1,
    routingId: 2,
    detached: false,
    isDestroyed: () => false,
    url: "data:text/html,recovery",
  }
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  expect(trustedServerFrame(event, contents, null, frame.url)).toBe(true)
  expect(trustedServerFrame(event, contents, null, "data:text/html,other")).toBe(false)
  expect(
    trustedServerFrame(
      { ...event, senderFrame: { ...frame, routingId: 3 } } as IpcMainInvokeEvent,
      contents,
      null,
      frame.url,
    ),
  ).toBe(false)
  frame.url = "http://127.0.0.1:4501/settings"
  expect(trustedServerFrame(event, contents, "http://127.0.0.1:4501", null)).toBe(true)
  expect(trustedServerFrame(event, contents, "http://127.0.0.1:4502", null)).toBe(false)
  frame.detached = true
  expect(trustedServerFrame(event, contents, "http://127.0.0.1:4501", null)).toBe(false)
})

test("double clicks coalesce, conflicting actions reject, and failures release the action", async () => {
  const actions = new DesktopServerActions()
  const held = Promise.withResolvers<number>()
  let calls = 0
  const first = actions.run("maintenance", () => {
    calls++
    return held.promise
  })
  const second = actions.run("maintenance", async () => 2)
  expect(second).toBe(first)
  await expect(actions.run("retry", async () => 3)).rejects.toThrow("in progress")
  held.resolve(1)
  expect(await first).toBe(1)
  expect(calls).toBe(1)
  await expect(
    actions.run("retry", async () => {
      throw new Error("failure")
    }),
  ).rejects.toThrow("failure")
  expect(await actions.run("retry", async () => 4)).toBe(4)
})
