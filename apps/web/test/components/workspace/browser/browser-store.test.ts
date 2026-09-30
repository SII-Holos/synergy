import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createBrowserStore, type BrowserPage } from "../../../../src/components/workspace/browser/browser-store"
const page = (id: string): BrowserPage => ({
  id,
  profileId: "personal",
  status: "active",
  title: id,
  url: `https://${id}.example.com`,
  isLoading: false,
  lastActiveAt: null,
})
test("agent updates and new pages preserve the human's selected tab", () =>
  createRoot((dispose) => {
    const store = createBrowserStore()
    store.replacePages([page("human"), page("agent")])
    store.selectPage("human")
    store.applyAgentActivity({ pageId: "agent", url: "https://agent.example.com", kind: "acting", label: "Clicking" })
    store.upsertPage({ ...page("agent"), title: "Updated" })
    store.upsertPage(page("popup"))
    expect(store.pageId()).toBe("human")
    expect(store.activities.agent?.kind).toBe("acting")
    store.followAgentNow()
    expect(store.pageId()).toBe("agent")
    store.replacePages([page("popup"), page("agent"), page("human")])
    expect(store.pageId()).toBe("agent")
    dispose()
  }))
test("page errors, prompts and file choosers survive switching and disappear on closure", () =>
  createRoot((dispose) => {
    const store = createBrowserStore()
    store.replacePages([page("one"), page("two")])
    store.setBrowserError({ pageId: "two", severity: "error", message: "Two failed" })
    store.setBrowserError({ pageId: "one", severity: "error", message: "One failed" })
    store.clearPageError("one")
    store.setDialogRequest({ pageId: "two", requestId: "d", type: "prompt", message: "Name" })
    store.setFileChooserRequest({ pageId: "one", requestId: "f", multiple: false, accept: [] })
    expect(store.browserError()).toBeNull()
    expect(store.dialogRequest()).toBeNull()
    expect(store.fileChooserRequest()?.requestId).toBe("f")
    store.selectPage("two")
    expect(store.browserError()?.message).toBe("Two failed")
    expect(store.dialogRequest()?.requestId).toBe("d")
    expect(store.fileChooserRequest()).toBeNull()
    store.removePage("two")
    expect(store.pageId()).toBe("one")
    expect(store.dialogs.two).toBeUndefined()
    dispose()
  }))
test("user navigation opens an empty browser or explicitly targets the selected page", () =>
  createRoot((dispose) => {
    const store = createBrowserStore(),
      sent: Record<string, unknown>[] = []
    store._setSend((message) => sent.push(message))
    store.navigate("example.com")
    expect(sent[0]).toMatchObject({ type: "page.open", url: "example.com" })
    store.replacePages([page("one"), page("two")])
    store.selectPage("two")
    store.navigate("other.example.com")
    expect(sent[1]).toMatchObject({ type: "navigate", pageId: "two", source: "user" })
    expect(store.page()?.isLoading).toBe(true)
    store.send({ type: "close", pageId: "one" })
    expect(sent[2]).toMatchObject({ pageId: "one", type: "close" })
    dispose()
  }))
test("viewport choices are local without a page and page-scoped when attached", () =>
  createRoot((dispose) => {
    const store = createBrowserStore(),
      sent: Record<string, unknown>[] = []
    store._setSend((message) => sent.push(message))
    store.setViewport(375.4, 667.6)
    expect(sent).toEqual([])
    expect(store.viewportHeight()).toBe(668)
    store.replacePages([page("one")])
    store.setViewport(900, 640, { mode: "fit" })
    expect(sent[0]).toMatchObject({ type: "input.resize", pageId: "one", width: 900, height: 640 })
    expect(store.viewportMode()).toBe("fit")
    store.upsertPage({ ...page("one"), status: "suspended" })
    store.setViewport(1000, 700, { mode: "fit" })
    expect(sent).toHaveLength(1)
    expect(store.viewportWidth()).toBe(1000)
    dispose()
  }))
