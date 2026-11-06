import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { approvePreviewPlugins, openPluginPreviewPage, type PluginBrowserPage } from "../src/testing"

test("preview approval bounds response-body waits and identifies the blocked plugin", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  })
  try {
    const preview = {
      client: createSynergyClient({ baseUrl: server.url.origin }),
      plugins: [{ id: "blocked-fixture" }],
    } as unknown as Parameters<typeof approvePreviewPlugins>[0]
    await expect(approvePreviewPlugins(preview, { timeoutMs: 50 })).rejects.toThrow(
      "approval review timed out for blocked-fixture",
    )
  } finally {
    server.stop(true)
  }
})

test("preview browser observers are removed on navigation failure and explicit disposal", async () => {
  const listeners = new Set<(error: Error) => void>()
  let fail = true
  const page: PluginBrowserPage = {
    goto: async () => {
      if (fail) throw new Error("navigation failed")
    },
    on: (_event, listener) => {
      listeners.add(listener)
    },
    off: (_event, listener) => {
      listeners.delete(listener)
    },
  }
  const preview = { url: "http://localhost/fixture" } as Parameters<typeof openPluginPreviewPage>[0]
  await expect(openPluginPreviewPage(preview, page)).rejects.toThrow("navigation failed")
  expect(listeners.size).toBe(0)
  fail = false
  const observation = await openPluginPreviewPage(preview, page)
  for (const listener of listeners) listener(new Error("render failed"))
  expect(observation.errors.map((error) => error.message)).toEqual(["render failed"])
  observation.dispose()
  expect(listeners.size).toBe(0)
})
