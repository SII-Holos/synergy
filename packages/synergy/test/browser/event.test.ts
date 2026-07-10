import { afterEach, describe, expect, test } from "bun:test"
import { BrowserNativeLease } from "@ericsanchezok/synergy-browser/native-lease"
import { BrowserBroker } from "../../src/browser/broker"
import { BrowserEvent } from "../../src/browser/event"
import { BrowserNativePresentation } from "../../src/browser/native-presentation"
import { BrowserOwner } from "../../src/browser/owner"

const owner: BrowserOwner.Info = {
  mode: "session",
  scopeID: "scope",
  sessionID: "session",
  directory: "/tmp/workspace",
}

afterEach(() => {
  BrowserNativePresentation.resetForTest()
})

describe("Browser event sequencing", () => {
  test("publishes contiguous owner events and replays only within the current epoch", () => {
    const eventOwner = { ...owner, sessionID: crypto.randomUUID() }
    const received: string[] = []
    const unsubscribe = BrowserEvent.subscribe(eventOwner, (event) => received.push(event.type))
    const created = BrowserEvent.publish(eventOwner, {
      type: "page.created",
      page: { id: "page", url: "about:blank", title: "", isLoading: false, lastActiveAt: null },
    })
    const closed = BrowserEvent.publish(eventOwner, { type: "page.closed", pageId: "page" })
    unsubscribe()

    expect([created.seq, closed.seq]).toEqual([1, 2])
    expect(received).toEqual(["page.created", "page.closed"])
    expect(BrowserEvent.replay(eventOwner, 1, created.epoch)?.map((event) => event.type)).toEqual(["page.closed"])
    expect(BrowserEvent.replay(eventOwner, 1, "stale-epoch")).toBeNull()
    BrowserEvent.remove(eventOwner)
  })
})

describe("native Browser presentation tickets", () => {
  test("binds a single use to owner and server origin", () => {
    const token = BrowserNativeLease.issue(BrowserBroker.secret(), {
      ownerKey: BrowserOwner.key(owner),
      serverOrigin: "http://127.0.0.1:4096",
    })
    expect(BrowserNativePresentation.consume(owner, "http://127.0.0.1:4096", token)).toBe(true)
    expect(() => BrowserNativePresentation.consume(owner, "http://127.0.0.1:4096", token)).toThrow(/already used/i)

    const wrongServer = BrowserNativeLease.issue(BrowserBroker.secret(), {
      ownerKey: BrowserOwner.key(owner),
      serverOrigin: "http://127.0.0.1:4096",
    })
    expect(() => BrowserNativePresentation.consume(owner, "http://127.0.0.1:5000", wrongServer)).toThrow(/server/i)
  })
})
