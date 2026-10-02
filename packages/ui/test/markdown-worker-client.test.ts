import { expect, test } from "bun:test"
import { createMarkdownWorkerClient } from "../src/context/markdown-worker-client"

test("Markdown worker jobs are lazy, cancellable, and fenced by their request identity", async () => {
  let starts = 0
  const sent: { id: number; markdown?: string; cancel?: boolean }[] = []
  let receive!: (event: MessageEvent) => void
  let terminated = false
  const client = createMarkdownWorkerClient(() => {
    starts++
    return {
      postMessage: (data) => sent.push(data),
      onMessage: (callback) => (receive = callback),
      terminate: () => (terminated = true),
    }
  })
  expect(starts).toBe(0)
  const controller = new AbortController()
  const old = client.parse("old", controller.signal)
  const current = client.parse("new")
  controller.abort()
  await expect(old).rejects.toThrow()
  receive({ data: { id: sent[0].id, html: "obsolete" } } as MessageEvent)
  receive({ data: { id: sent[1].id, html: "current" } } as MessageEvent)
  expect(await current).toBe("current")
  expect(starts).toBe(1)
  expect(sent.some((message) => message.cancel)).toBe(true)
  client.dispose()
  expect(terminated).toBe(true)
})

test("a failed Markdown worker rejects pending work and the next request creates a fresh worker", async () => {
  let starts = 0
  let fail!: (error: Error) => void
  let receive!: (event: MessageEvent) => void
  let sentID = 0
  const client = createMarkdownWorkerClient(() => {
    starts++
    return {
      postMessage: (message) => {
        sentID = message.id
      },
      onMessage: (callback) => (receive = callback),
      onError: (callback) => (fail = callback),
      terminate: () => {},
    }
  })
  const first = client.parse("before crash")
  fail(new Error("worker crashed"))
  await expect(first).rejects.toThrow("worker crashed")
  const next = client.parse("recovered")
  receive({ data: { id: sentID, html: "recovered" } } as MessageEvent)
  expect(await next).toBe("recovered")
  expect(starts).toBe(2)
  client.dispose()
})
