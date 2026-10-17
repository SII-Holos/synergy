import { expect, test } from "bun:test"

test("metadata updates preserve an empty selection for a silently added page", () => {
  const tab = browserPageTab(page("one"), shared)
  const next = reconcileBrowserTabs({
    tabs: [tab],
    active: undefined,
    pages: [page("one", "Navigated")],
    route: shared,
  })
  expect(next.active).toBeUndefined()
  expect(next.tabs[0]?.title).toBe("Navigated")
})

test("Agent pages join only their creating Session, including blank pages and recovered catalogs", () => {
  const pages = [
    { ...page("one"), url: "about:blank", createdBySessionID: "one" },
    { ...page("two"), createdBySessionID: "two" },
    page("unattributed"),
    { ...page("popup"), openerId: "one" },
  ]
  const tabs = [{ id: "file", panelId: "file" }]
  const one = reconcileBrowserTabs({ tabs, active: "file", pages, route: shared, sessionID: "one" })
  expect(one.tabs.map((tab) => tab.resourceId)).toEqual([undefined, "one", "popup"])
  expect(one.active).toBe("file")
  const two = reconcileBrowserTabs({ tabs: [], active: undefined, pages, route: shared, sessionID: "two" })
  expect(two.tabs.map((tab) => tab.resourceId)).toEqual(["two"])
  expect(two.active).toBeUndefined()
  expect(reconcileBrowserTabs({ ...one, pages, route: shared, sessionID: "one" }).tabs).toBe(one.tabs)
})
import {
  browserPageTab,
  reconcileBrowserTabs,
} from "../../../../src/components/workspace/browser/browser-workbench-model"
const route = { mode: "session" as const, sessionID: "session-one", path_directory: "home", scopeID: "home" }
const shared = {
  mode: "scope" as const,
  path_directory: "home",
  scopeID: "home",
  ownerKey: "scope-owner",
  serverUrl: "http://one",
}
const page = (id: string, title = id) => ({ id, title, url: `https://${id}.test` })
test("shared pages update only the browser tabs opened in each task", () => {
  const one = browserPageTab(page("one"), shared)
  const two = browserPageTab(page("two"), shared)
  const pages = [page("one", "Updated"), page("two"), page("background")]
  const first = reconcileBrowserTabs({ tabs: [one], active: one.id, pages, route: shared })
  const second = reconcileBrowserTabs({ tabs: [two], active: two.id, pages, route: shared })
  expect(first.tabs.map((tab) => tab.resourceId)).toEqual(["one"])
  expect(first.tabs[0]?.title).toBe("Updated")
  expect(first.active).toBe(one.id)
  expect(second.tabs).toEqual([two])
  expect(second.active).toBe(two.id)
  expect(reconcileBrowserTabs({ tabs: [], active: undefined, pages, route: shared })).toEqual({
    tabs: [],
    active: undefined,
  })
  const closed = reconcileBrowserTabs({ ...first, pages: [page("two")], route: shared })
  expect(closed).toEqual({ tabs: [], active: undefined })
})

test("shared popups follow an opened ancestor without importing another task's pages", () => {
  const one = browserPageTab(page("one"), shared)
  const pages = [
    { ...page("nested"), openerId: "popup" },
    { ...page("popup"), openerId: "one" },
    { ...page("foreign-popup"), openerId: "two" },
    { ...page("cycle-one"), openerId: "cycle-two" },
    { ...page("cycle-two"), openerId: "cycle-one" },
    page("one"),
    page("two"),
  ]
  const next = reconcileBrowserTabs({ tabs: [one], active: one.id, pages, route: shared })
  expect(next.tabs.map((tab) => tab.resourceId)).toEqual(["one", "nested", "popup"])
  expect(next.active).toBe(one.id)
  expect(reconcileBrowserTabs({ ...next, pages, route: shared }).tabs).toBe(next.tabs)
  const closed = reconcileBrowserTabs({ ...next, pages: pages.filter((page) => page.id !== "one"), route: shared })
  expect(closed.tabs.map((tab) => tab.resourceId)).toEqual(["nested", "popup"])
})

test("each native page becomes a peer tab without changing the active file or order", () => {
  const tabs = [
    { id: "file", panelId: "file" },
    { id: "b", panelId: "browser", resourceId: "one", title: "Old" },
  ]
  const next = reconcileBrowserTabs({ tabs, active: "file", pages: [page("one", "Renamed"), page("popup")], route })
  expect(next.active).toBe("file")
  expect(next.tabs.map((tab) => [tab.panelId, tab.resourceId])).toEqual([
    ["file", undefined],
    ["browser", "one"],
    ["browser", "popup"],
  ])
  expect(next.tabs[1]?.id).toBe("b")
  expect(next.tabs[1]?.title).toBe("Renamed")
  expect(reconcileBrowserTabs({ ...next, pages: [page("one", "Renamed"), page("popup")], route }).tabs).toBe(next.tabs)
})
test("the former browser container resolves to a page and closing a popup removes only its peer tab", () => {
  const next = reconcileBrowserTabs({
    tabs: [{ id: "legacy", panelId: "browser" }],
    active: "legacy",
    pages: [page("one"), page("two")],
    route,
  })
  expect(next.tabs[0]?.resourceId).toBe("one")
  expect(next.active).toBe("legacy")
  const closed = reconcileBrowserTabs({ ...next, pages: [page("one")], route })
  expect(closed.tabs).toHaveLength(1)
  expect(closed.active).toBe("legacy")
})
test("a closed selected page picks a surviving peer and never leaves a stale resource", () => {
  const next = reconcileBrowserTabs({
    tabs: [
      { id: "file", panelId: "file" },
      { id: "b", panelId: "browser", resourceId: "one" },
    ],
    active: "b",
    pages: [],
    route,
  })
  expect(next.tabs).toEqual([{ id: "file", panelId: "file" }])
  expect(next.active).toBe("file")
})

test("a local open response arriving before its event cannot lose its new tab", () => {
  const tabs = [
    { id: "one", panelId: "browser", resourceId: "one" },
    { id: "new", panelId: "browser", resourceId: "new" },
  ]
  const next = reconcileBrowserTabs({
    tabs,
    active: "new",
    pages: [page("one")],
    route,
    knownPageIds: new Set(["one"]),
  })
  expect(next.tabs.map((tab) => tab.resourceId)).toEqual(["one", "new"])
  expect(next.active).toBe("new")
})

test("page menu address follows navigation even when the website title is unchanged", () => {
  const first = reconcileBrowserTabs({ tabs: [], active: undefined, pages: [page("one", "Website")], route })
  const second = reconcileBrowserTabs({
    ...first,
    pages: [{ ...page("one", "Website"), url: "https://one.test/next" }],
    route,
  })
  expect(second.tabs[0]?.state).toMatchObject({ browserURL: "https://one.test/next" })
  expect(second.active).toBe(first.active)
})

test("a shared catalog preserves historical owners and separates identical page IDs across runtimes", () => {
  const old = browserPageTab(page("same"), { ...route, ownerKey: "session-owner", serverUrl: "http://one" })
  const other = browserPageTab(page("same"), { ...shared, serverUrl: "http://two" })
  const current = browserPageTab(page("same"), shared)
  expect(new Set([old.id, other.id, current.id]).size).toBe(3)
  const next = reconcileBrowserTabs({ tabs: [old, other], active: old.id, pages: [page("same")], route: shared })
  expect(next.tabs).toEqual([old, other])
  expect(next.active).toBe(old.id)
})
