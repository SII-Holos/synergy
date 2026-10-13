import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
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

test("page projections share live catalog updates without sharing selection", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const [firstId, setFirstId] = createSignal("human")
    const [secondId, setSecondId] = createSignal("agent")
    const firstSelections: string[] = []
    const secondSelections: string[] = []
    const first = catalog.forPage(firstId, (id) => {
      firstSelections.push(id)
      setFirstId(id)
    })
    const second = catalog.forPage(secondId, (id) => {
      secondSelections.push(id)
      setSecondId(id)
    })
    catalog.replacePages([page("human"), page("agent")])
    catalog.applyAgentActivity({ pageId: "agent", url: "https://agent.example.com", kind: "acting", label: "Clicking" })
    catalog.upsertPage({ ...page("agent"), title: "Updated" })
    catalog.upsertPage(page("popup"))
    catalog.setPageUrl("human", "https://human.example.com/next")
    catalog.setPageLoading("agent", true)

    expect(first.pageId()).toBe("human")
    expect(first.page()?.url).toBe("https://human.example.com/next")
    expect(second.page()).toMatchObject({ id: "agent", title: "Updated", isLoading: true })
    expect(firstSelections).toEqual([])
    expect(secondSelections).toEqual([])
    catalog.replacePages([page("popup"), page("agent"), page("human")])
    expect(first.pageId()).toBe("human")
    expect(second.pageId()).toBe("agent")

    first.followAgentNow()
    expect(first.pageId()).toBe("agent")
    expect(firstSelections).toEqual(["agent"])
    expect(secondSelections).toEqual([])
    second.selectPage("popup")
    expect(first.pageId()).toBe("agent")
    expect(second.pageId()).toBe("popup")
    expect(secondSelections).toEqual(["popup"])
    dispose()
  }))

test("missing, empty and closed page projections never fall back to another catalog page", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const selections: string[] = []
    const sent: Record<string, unknown>[] = []
    const select = (id: string) => {
      selections.push(id)
    }
    const first = catalog.forPage(() => "one", select)
    const second = catalog.forPage(() => "two", select)
    const missing = catalog.forPage(() => "missing", select)
    const empty = catalog.forPage(() => undefined, select)
    catalog._setSend((message) => {
      sent.push(message)
    })
    catalog.replacePages([page("one"), page("two")])
    expect(first.pageId()).toBe("one")
    expect(missing.page()).toBeNull()
    expect(missing.pageId()).toBeNull()
    expect(empty.page()).toBeNull()
    expect(empty.pageId()).toBeNull()

    catalog.removePage("one")
    expect(first.page()).toBeNull()
    expect(first.pageId()).toBeNull()
    expect(second.pageId()).toBe("two")
    first.navigate("https://closed.example.com")
    missing.navigate("https://missing.example.com")
    expect(sent).toEqual([])
    first.send({ type: "reload" })
    second.send({ type: "reload" })
    expect(sent).toEqual([
      { type: "reload", pageId: "one" },
      { type: "reload", pageId: "two" },
    ])
    catalog.replacePages([page("popup"), page("two")])
    expect(first.page()).toBeNull()
    expect(missing.page()).toBeNull()
    expect(empty.page()).toBeNull()
    expect(second.pageId()).toBe("two")
    expect(selections).toEqual([])
    dispose()
  }))

test("page errors and prompts stay keyed across local selection and closure", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const [selected, setSelected] = createSignal("one")
    const first = catalog.forPage(selected, setSelected)
    const second = catalog.forPage(
      () => "two",
      () => {},
    )
    catalog.replacePages([page("one"), page("two")])
    catalog.setBrowserError({ severity: "warning", message: "Connection failed" })
    catalog.setBrowserError({ pageId: "one", severity: "error", message: "One failed" })
    catalog.setBrowserError({ pageId: "two", severity: "error", message: "Two failed" })
    catalog.setDialogRequest({ pageId: "one", requestId: "dialog-one", type: "prompt", message: "One" })
    catalog.setDialogRequest({ pageId: "two", requestId: "dialog-two", type: "prompt", message: "Two" })
    catalog.setFileChooserRequest({ pageId: "one", requestId: "file-one", multiple: false, accept: [] })
    catalog.setFileChooserRequest({ pageId: "two", requestId: "file-two", multiple: true, accept: ["image/*"] })

    expect(first.browserError()?.message).toBe("One failed")
    expect(second.browserError()?.message).toBe("Two failed")
    expect(first.dialogRequest()?.requestId).toBe("dialog-one")
    expect(second.dialogRequest()?.requestId).toBe("dialog-two")
    expect(first.fileChooserRequest()?.requestId).toBe("file-one")
    expect(second.fileChooserRequest()?.requestId).toBe("file-two")
    first.setBrowserError(null)
    expect(first.browserError()?.message).toBe("Connection failed")
    expect(second.browserError()?.message).toBe("Two failed")
    first.setBrowserError({ severity: "error", message: "One local failure" })
    expect(catalog.pageErrors.one?.message).toBe("One local failure")
    expect(catalog.pageErrors.global?.message).toBe("Connection failed")

    first.selectPage("two")
    expect(first.dialogRequest()?.requestId).toBe("dialog-two")
    expect(first.fileChooserRequest()?.requestId).toBe("file-two")
    first.setDialogRequest(null)
    first.setFileChooserRequest(null)
    expect(second.dialogRequest()).toBeNull()
    expect(second.fileChooserRequest()).toBeNull()
    expect(catalog.dialogs.one?.requestId).toBe("dialog-one")
    expect(catalog.fileChoosers.one?.requestId).toBe("file-one")
    catalog.removePage("two")
    expect(first.pageId()).toBeNull()
    expect(second.pageId()).toBeNull()
    expect(catalog.pageErrors.two).toBeUndefined()
    expect(first.browserError()?.message).toBe("Connection failed")
    expect(catalog.pageErrors.one?.message).toBe("One local failure")
    catalog.setBrowserError(null)
    expect(second.browserError()).toBeNull()
    first.selectPage("one")
    expect(first.browserError()?.message).toBe("One local failure")
    expect(first.dialogRequest()?.requestId).toBe("dialog-one")
    expect(first.fileChooserRequest()?.requestId).toBe("file-one")
    catalog.removePage("one")
    expect(first.browserError()).toBeNull()
    expect(first.dialogRequest()).toBeNull()
    expect(first.fileChooserRequest()).toBeNull()
    dispose()
  }))

test("dismissing the visible page error then global error preserves another page's error", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const first = catalog.forPage(
      () => "one",
      () => {},
    )
    const second = catalog.forPage(
      () => "two",
      () => {},
    )
    catalog.replacePages([page("one"), page("two")])
    catalog.setBrowserError({ severity: "warning", message: "Connection failed" })
    catalog.setBrowserError({ pageId: "one", severity: "error", message: "One failed" })
    catalog.setBrowserError({ pageId: "two", severity: "error", message: "Two failed" })

    expect(first.browserError()?.message).toBe("One failed")
    first.setBrowserError(null)
    expect(catalog.pageErrors.one).toBeUndefined()
    expect(catalog.pageErrors.global?.message).toBe("Connection failed")
    expect(first.browserError()?.message).toBe("Connection failed")
    expect(second.browserError()?.message).toBe("Two failed")
    first.setBrowserError(null)
    expect(catalog.pageErrors.global).toBeUndefined()
    expect(first.browserError()).toBeNull()
    expect(catalog.pageErrors.two?.message).toBe("Two failed")
    expect(second.browserError()?.message).toBe("Two failed")
    dispose()
  }))

test("page activity and host recovery cannot clear another page's state", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const first = catalog.forPage(
      () => "one",
      () => {},
    )
    const second = catalog.forPage(
      () => "two",
      () => {},
    )
    catalog.replacePages([page("one"), page("two")])
    for (const id of ["one", "two"]) {
      catalog.applyAgentActivity({ pageId: id, operationID: id, url: page(id).url, kind: "acting", label: id })
      catalog.setHostStatus(id, "restarting")
      catalog.setBrowserError({ pageId: id, severity: "error", code: "browser_host_disconnected", message: id })
    }
    catalog.applyAgentActivity({ pageId: "one", operationID: "stale", url: null, kind: "idle", label: null })
    expect(catalog.activities.one?.kind).toBe("acting")
    expect(catalog.activities.two?.kind).toBe("acting")
    catalog.applyAgentActivity({ pageId: "one", operationID: "one", url: null, kind: "idle", label: null })
    expect(catalog.activities.one?.kind).toBe("idle")
    expect(catalog.activities.two?.kind).toBe("acting")
    catalog.setHostStatus("one", "ready")
    expect(first.browserError()).toBeNull()
    expect(first.hostStatus()).toBe("ready")
    expect(second.browserError()?.message).toBe("two")
    expect(second.hostStatus()).toBe("restarting")
    catalog.removePage("one")
    expect(catalog.activities.one).toBeUndefined()
    expect(catalog.hostStatuses.one).toBeUndefined()
    expect(catalog.activities.two?.kind).toBe("acting")
    expect(second.hostStatus()).toBe("restarting")
    dispose()
  }))

test("navigation opens an untargeted view or sends an explicit page command", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const sent: Record<string, unknown>[] = []
    const empty = catalog.forPage(
      () => undefined,
      () => {},
    )
    const first = catalog.forPage(
      () => "one",
      () => {},
    )
    const second = catalog.forPage(
      () => "two",
      () => {},
    )
    catalog._setSend((message) => {
      sent.push(message)
    })
    catalog.replacePages([page("one"), page("two")])
    empty.navigate("example.com")
    second.navigate("other.example.com")
    expect(sent).toEqual([
      { type: "page.open", pageId: undefined, url: "example.com", profileId: undefined },
      { type: "navigate", pageId: "two", source: "user", url: "other.example.com" },
    ])
    expect(first.page()?.isLoading).toBe(false)
    expect(second.page()?.isLoading).toBe(true)
    first.send({ type: "close" })
    expect(sent[2]).toEqual({ pageId: "one", type: "close" })
    dispose()
  }))

test("asynchronous open replies select only their initiating page view", () =>
  createRoot(async (dispose) => {
    const catalog = createBrowserStore()
    const firstSelections: string[] = []
    const secondSelections: string[] = []
    const replies: Array<(opened: BrowserPage | undefined) => void> = []
    const first = catalog.forPage(
      () => "one",
      (id) => {
        firstSelections.push(id)
      },
    )
    const second = catalog.forPage(
      () => "two",
      (id) => {
        secondSelections.push(id)
      },
    )
    catalog.replacePages([page("one"), page("two")])
    catalog._setSend(
      () =>
        new Promise<BrowserPage | undefined>((resolve) => {
          replies.push(resolve)
        }),
    )
    try {
      const firstOpen = first.openPage("https://first.example.com")
      const secondOpen = second.openPage("https://second.example.com", "work")
      catalog.upsertPage(page("popup"))
      expect(firstSelections).toEqual([])
      expect(secondSelections).toEqual([])
      catalog.upsertPage(page("opened-two"))
      replies[1]!(page("opened-two"))
      await secondOpen
      expect(firstSelections).toEqual([])
      expect(secondSelections).toEqual(["opened-two"])
      catalog.upsertPage(page("opened-one"))
      replies[0]!(page("opened-one"))
      await firstOpen
      expect(firstSelections).toEqual(["opened-one"])
      expect(secondSelections).toEqual(["opened-two"])
      const noPage = first.openPage()
      replies[2]!(undefined)
      await noPage
      expect(firstSelections).toEqual(["opened-one"])
      expect(secondSelections).toEqual(["opened-two"])
    } finally {
      dispose()
    }
  }))

test("two views of the same page keep independent local controls", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const first = catalog.forPage(
      () => "one",
      () => {},
    )
    const second = catalog.forPage(
      () => "one",
      () => {},
    )
    const target = { displayX: 10, displayY: 20, pageX: 30, pageY: 40 }
    catalog.replacePages([page("one")])
    first.setDevPanel("console")
    first.setControlsOpen(true)
    first.setAddressSuggestionsOpen(true)
    first.setAnnotationMode(true)
    first.setAnnotationTarget(target)
    first.setFollowAgent(true)
    expect(first.devPanel()).toBe("console")
    expect(first.controlsOpen()).toBe(true)
    expect(first.addressSuggestionsOpen()).toBe(true)
    expect(first.annotationMode()).toBe(true)
    expect(first.annotationTarget()).toEqual(target)
    expect(first.followAgent()).toBe(true)
    expect(second.devPanel()).toBe("closed")
    expect(second.controlsOpen()).toBe(false)
    expect(second.addressSuggestionsOpen()).toBe(false)
    expect(second.annotationMode()).toBe(false)
    expect(second.annotationTarget()).toBeNull()
    expect(second.followAgent()).toBe(false)
    second.toggleDevPanel("network")
    first.toggleDevPanel("console")
    first.clearAnnotationTarget()
    expect(first.devPanel()).toBe("closed")
    expect(second.devPanel()).toBe("network")
    expect(first.annotationTarget()).toBeNull()
    dispose()
  }))

test("explicit fixed and fit viewport commands target only their active page", () =>
  createRoot((dispose) => {
    const catalog = createBrowserStore()
    const sent: Record<string, unknown>[] = []
    const [target, setTarget] = createSignal<string>()
    const first = catalog.forPage(target, setTarget)
    const second = catalog.forPage(
      () => "two",
      () => {},
    )
    catalog._setSend((message) => {
      sent.push(message)
    })
    catalog.replacePages([page("one"), page("two")])
    first.setViewport(375.4, 667.6)
    expect(sent).toEqual([])
    expect(first.viewportWidth()).toBe(375)
    expect(first.viewportHeight()).toBe(668)
    expect(first.viewportMode()).toBe("fixed")
    setTarget("one")
    first.setViewport(900, 640, { mode: "fit" })
    expect(first.viewportWidth()).toBe(900)
    expect(first.viewportHeight()).toBe(640)
    expect(first.viewportMode()).toBe("fit")
    expect(second.viewportWidth()).toBe(1280)
    expect(second.viewportHeight()).toBe(720)
    expect(second.viewportMode()).toBe("fit")
    expect(sent).toEqual([{ type: "input.resize", pageId: "one", width: 900, height: 640, mode: "fit" }])
    second.setViewport(1024, 768)
    first.setViewport(800, 600, { mode: "fixed" })
    expect(sent).toEqual([
      { type: "input.resize", pageId: "one", width: 900, height: 640, mode: "fit" },
      { type: "input.resize", pageId: "two", width: 1024, height: 768 },
      { type: "input.resize", pageId: "one", width: 800, height: 600 },
    ])
    first.setViewport(901, 650, { mode: "fit" })
    expect(sent.at(-1)).toEqual({ type: "input.resize", pageId: "one", width: 901, height: 650, mode: "fit" })
    catalog.upsertPage({ ...page("one"), status: "suspended" })
    first.setViewport(1000, 700)
    expect(sent).toHaveLength(4)
    expect(first.viewportWidth()).toBe(1000)
    expect(first.viewportHeight()).toBe(700)
    expect(second.viewportWidth()).toBe(1024)
    expect(second.viewportHeight()).toBe(768)
    expect(second.viewportMode()).toBe("fixed")
    dispose()
  }))
