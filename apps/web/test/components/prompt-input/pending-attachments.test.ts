import { describe, expect, test } from "bun:test"
import { createPendingAttachmentTracker } from "../../../src/components/prompt-input/pending-attachments"

const entry = (id: string, size = 10) => ({ id, filename: `${id}.png`, mime: "image/png", size })
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25))

describe("pending attachment tracker", () => {
  test("tracks uploads from begin until end", () => {
    const tracker = createPendingAttachmentTracker()
    expect(tracker.uploading()).toBe(false)
    expect(tracker.pending()).toEqual([])

    tracker.begin(entry("prt-1", 1024))
    expect(tracker.uploading()).toBe(true)
    expect(tracker.pending()).toEqual([
      { id: "prt-1", filename: "prt-1.png", mime: "image/png", size: 1024, status: "uploading" },
    ])

    tracker.end("prt-1")
    expect(tracker.uploading()).toBe(false)
    expect(tracker.pending()).toEqual([])
  })

  test("markUploaded stops blocking send, flashes, then auto-removes", async () => {
    const tracker = createPendingAttachmentTracker({ flashMs: 10 })
    tracker.begin(entry("prt-1"))

    tracker.markUploaded("prt-1")
    expect(tracker.uploading()).toBe(false)
    expect(tracker.pending().map((pending) => pending.status)).toEqual(["uploaded"])

    await tick()
    expect(tracker.pending()).toEqual([])
    expect(tracker.uploading()).toBe(false)
  })

  test("cancel removes the entry and marks the upload as cancelled", () => {
    const tracker = createPendingAttachmentTracker()
    tracker.begin(entry("prt-1"))
    tracker.begin(entry("prt-2", 20))

    expect(tracker.cancel("prt-1")).toBe(true)
    expect(tracker.uploading()).toBe(true)
    expect(tracker.pending().map((pending) => pending.id)).toEqual(["prt-2"])
    expect(tracker.isCancelled("prt-1")).toBe(true)
    expect(tracker.isCancelled("prt-2")).toBe(false)

    expect(tracker.cancel("prt-missing")).toBe(false)
    tracker.end("prt-2")
    expect(tracker.cancel("prt-2")).toBe(false)
  })

  test("cancel and end also clear a flashing entry immediately", () => {
    const tracker = createPendingAttachmentTracker({ flashMs: 5000 })
    tracker.begin(entry("prt-1"))
    tracker.markUploaded("prt-1")

    expect(tracker.cancel("prt-1")).toBe(true)
    expect(tracker.pending()).toEqual([])
    expect(tracker.uploading()).toBe(false)

    tracker.begin(entry("prt-2"))
    tracker.markUploaded("prt-2")
    tracker.end("prt-2")
    expect(tracker.pending()).toEqual([])
  })

  test("a re-begun id is no longer considered cancelled", () => {
    const tracker = createPendingAttachmentTracker()
    tracker.begin(entry("prt-1"))
    tracker.cancel("prt-1")
    tracker.begin(entry("prt-1"))
    expect(tracker.isCancelled("prt-1")).toBe(false)
    expect(tracker.uploading()).toBe(true)
  })

  test("scope reports only in-flight entries, not uploaded flashes", () => {
    const tracker = createPendingAttachmentTracker({ flashMs: 5000 })
    tracker.begin(entry("prt-1", 30))
    tracker.begin(entry("prt-2", 12))
    tracker.markUploaded("prt-1")
    expect(tracker.scope()).toEqual({ count: 1, bytes: 12 })
  })
})
