import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createBrowserStore } from "./browser-store"

describe("createBrowserStore activity", () => {
  test("records agent activity without changing the single visible page", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      store.setSession("page", { id: "page-user", title: "User", url: "https://user.test", isLoading: false })

      store.applyAgentActivity({
        pageId: "page-agent",
        url: "https://agent.test",
        kind: "acting",
        tool: "browser_action",
        label: "Clicking",
      })

      expect(store.pageId()).toBe("page-user")
      expect(store.agentActivity().pageId).toBe("page-agent")
      dispose()
    })
  })
})

describe("createBrowserStore navigate", () => {
  test("sends navigate without a page id when no page exists", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))

      store.navigate("www.google.com")

      expect(sent).toEqual([{ type: "navigate", source: "user", url: "www.google.com" }])
      dispose()
    })
  })

  test("navigates the existing page when one is open", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))
      store.setSession("page", { id: "page-1", title: "Start", url: "about:blank", isLoading: false })

      store.navigate("www.google.com")

      expect(store.session.page?.isLoading).toBe(true)
      expect(sent).toEqual([{ type: "navigate", source: "user", url: "www.google.com" }])
      dispose()
    })
  })
})

describe("createBrowserStore viewport", () => {
  test("records pageless manual viewport changes locally", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))

      store.setViewport(375.4, 667.6)

      expect(store.viewportMode()).toBe("fixed")
      expect(store.viewportWidth()).toBe(375)
      expect(store.viewportHeight()).toBe(668)
      expect(sent).toEqual([])
      dispose()
    })
  })

  test("keeps fit mode for surface-driven viewport changes", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))
      store.setSession("page", { id: "page-1", title: "Start", url: "about:blank", isLoading: false })

      store.setViewport(900, 640, { mode: "fit" })

      expect(store.viewportMode()).toBe("fit")
      expect(store.viewportWidth()).toBe(900)
      expect(store.viewportHeight()).toBe(640)
      expect(sent.at(-1)).toMatchObject({
        type: "input.resize",
        width: 900,
        height: 640,
      })
      dispose()
    })
  })

  test("sends WebRTC CSS viewport changes through the unified control route", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))
      store.setPresentation({
        protocolVersion: 2,
        kind: "webrtc",
        capabilities: { native: true, webrtc: true },
        reason: "remote-client",
      })
      store.setSession("page", { id: "page-1", title: "Start", url: "about:blank", isLoading: false })

      store.setViewport(800, 600, { mode: "fit" })
      store.setViewport(1024, 768, { mode: "fit" })

      expect(sent).toHaveLength(2)
      expect(sent[1]).toMatchObject({
        type: "input.resize",
        width: 1024,
        height: 768,
      })
      dispose()
    })
  })
})
