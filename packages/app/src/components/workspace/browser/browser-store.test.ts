import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createBrowserStore } from "./browser-store"

describe("createBrowserStore follow agent", () => {
  test("follows agent activity by default", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))
      store.setSession("tabs", [
        { id: "user-tab", title: "User", url: "https://user.test", isLoading: false },
        { id: "agent-tab", title: "Agent", url: "https://agent.test", isLoading: false },
      ])
      store.setSession("visibleTabId", "user-tab")

      store.applyAgentActivity({
        tabId: "agent-tab",
        url: "https://agent.test",
        kind: "acting",
        tool: "browser_click",
        label: "Clicking",
      })

      expect(store.activeTabId()).toBe("agent-tab")
      expect(sent.at(-1)).toEqual({ type: "stream.start", tabId: "agent-tab" })
      dispose()
    })
  })

  test("does not steal focus when follow agent is disabled", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      store._setSend(() => {})
      store.setSession("tabs", [
        { id: "user-tab", title: "User", url: "https://user.test", isLoading: false },
        { id: "agent-tab", title: "Agent", url: "https://agent.test", isLoading: false },
      ])
      store.setSession("visibleTabId", "user-tab")
      store.setFollowAgent(false)

      store.applyAgentActivity({
        tabId: "agent-tab",
        url: "https://agent.test",
        kind: "acting",
        tool: "browser_type",
        label: "Typing",
      })

      expect(store.activeTabId()).toBe("user-tab")
      expect(store.agentActivity().tabId).toBe("agent-tab")
      dispose()
    })
  })
})

describe("createBrowserStore navigate", () => {
  test("creates a tab with the URL when no tab is open", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))

      store.navigate("www.google.com")

      expect(sent).toEqual([
        { type: "setFollowAgent", enabled: false },
        { type: "createTab", url: "www.google.com" },
      ])
      dispose()
    })
  })

  test("navigates the active tab when one is open", () => {
    createRoot((dispose) => {
      const store = createBrowserStore()
      const sent: Record<string, unknown>[] = []
      store._setSend((msg) => sent.push(msg))
      store.setSession("tabs", [{ id: "tab-1", title: "Start", url: "about:blank", isLoading: false }])
      store.setSession("activeTabId", "tab-1")

      store.navigate("www.google.com")

      expect(store.session.tabs[0]?.isLoading).toBe(true)
      expect(sent).toEqual([
        { type: "setFollowAgent", enabled: false },
        { type: "navigate", source: "user", url: "www.google.com", tabId: "tab-1" },
      ])
      dispose()
    })
  })
})
