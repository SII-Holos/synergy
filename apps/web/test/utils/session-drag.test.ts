import { describe, expect, test } from "bun:test"
import { parseSessionDragPayload, setSessionDragData } from "../../src/utils/session-drag"

class FakeDataTransfer {
  data = new Map<string, string>()
  effectAllowed = ""
  dragImage: { node: HTMLElement; x: number; y: number } | null = null

  setData(type: string, value: string) {
    this.data.set(type, value)
  }

  getData(type: string) {
    return this.data.get(type) ?? ""
  }

  setDragImage(node: HTMLElement, x: number, y: number) {
    this.dragImage = { node, x, y }
  }
}

describe("setSessionDragData", () => {
  test("writes the canonical session payload, text/plain title, and copy effect", () => {
    const transfer = new FakeDataTransfer()
    const event = { dataTransfer: transfer } as unknown as DragEvent

    setSessionDragData(event, {
      connection: "http://server",
      id: "ses_abc",
      scopeID: "/repo",
      title: "My session",
      updatedAt: 1700000000000,
    })

    expect(transfer.effectAllowed).toBe("copy")
    expect(transfer.getData("text/plain")).toBe("My session")
    const payload = JSON.parse(transfer.getData("application/x-synergy-session")) as Record<string, unknown>
    expect(payload).toEqual({
      connection: "http://server",
      id: "ses_abc",
      scopeID: "/repo",
      title: "My session",
      updatedAt: 1700000000000,
    })
  })

  test("omits updatedAt when undefined and attaches a drag image", () => {
    const transfer = new FakeDataTransfer()
    const event = { dataTransfer: transfer } as unknown as DragEvent

    // happy-dom provides document.body; stub appendChild/removeChild to observe
    // the drag-image lifecycle without touching the real tree.
    const appended: HTMLElement[] = []
    const originalAppend = document.body.appendChild.bind(document.body)
    const originalRemove = document.body.removeChild.bind(document.body)
    document.body.appendChild = ((node: Node) => {
      appended.push(node as HTMLElement)
      return node
    }) as typeof document.body.appendChild
    document.body.removeChild = ((node: Node) => node) as typeof document.body.removeChild

    try {
      setSessionDragData(event, { connection: "http://server", id: "ses_abc", scopeID: "home", title: "Home" })

      const payload = JSON.parse(transfer.getData("application/x-synergy-session")) as Record<string, unknown>
      expect(payload).toEqual({ connection: "http://server", id: "ses_abc", scopeID: "home", title: "Home" })
      expect(appended.length).toBe(1)
      expect(transfer.dragImage).not.toBeNull()
    } finally {
      document.body.appendChild = originalAppend
      document.body.removeChild = originalRemove
    }
  })

  test("no-ops when dataTransfer is absent", () => {
    setSessionDragData({} as DragEvent, { connection: "http://server", id: "ses_abc", scopeID: "/repo", title: "T" })
    expect(true).toBe(true)
  })
})

describe("parseSessionDragPayload", () => {
  test("requires the source connection even when session identifiers are identical", () => {
    const payload = JSON.stringify({ connection: "http://server-a", scopeID: "home", id: "session", title: "Title" })
    expect(parseSessionDragPayload(payload, "http://server-a")).toEqual({ scopeKey: "home", sessionID: "session" })
    expect(parseSessionDragPayload(payload, "http://server-b")).toBeUndefined()
  })
  test("ignores malformed payloads and old drags without connection identity", () => {
    for (const value of [
      "not json",
      "",
      "null",
      JSON.stringify({ scopeKey: "home", sessionID: "session" }),
      JSON.stringify({ scopeID: "home", id: "session" }),
      JSON.stringify({ connection: "http://server", scopeID: "home", id: "" }),
    ]) {
      expect(parseSessionDragPayload(value, "http://server")).toBeUndefined()
    }
  })
})
