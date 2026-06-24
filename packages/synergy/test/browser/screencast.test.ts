import { describe, expect, mock, test } from "bun:test"
import { BrowserFrameStreamer } from "../../src/browser/screencast.js"

describe("BrowserFrameStreamer", () => {
  test("CDP fallback starts screencast, ACKs each frame, and stops cleanly", async () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
    let frameHandler: ((event: any) => void) | undefined
    const session = {
      send: mock(async (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params })
        return null
      }),
      on: mock((event: string, handler: (event: any) => void) => {
        if (event === "Page.screencastFrame") frameHandler = handler
      }),
      off: mock((_event: string, _handler: (event: any) => void) => {}),
      detach: mock(async () => {}),
    }
    const page = {
      viewportSize: mock(() => ({ width: 640, height: 480 })),
      context: () => ({
        newCDPSession: mock(async () => session),
      }),
    }
    const streamer = new BrowserFrameStreamer()
    const frames: any[] = []

    await streamer.start("tab-1", page as any, { format: "jpeg", quality: 70, fps: 60 }, (frame) => {
      frames.push(frame)
    })

    expect(sent[0]).toEqual({
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: 70,
        maxWidth: undefined,
        maxHeight: undefined,
        everyNthFrame: 1,
      },
    })
    expect(frameHandler).toBeDefined()

    frameHandler?.({
      data: "encoded-frame",
      metadata: {
        deviceWidth: 640,
        deviceHeight: 480,
        pageScaleFactor: 1,
        scrollOffsetX: 12,
        scrollOffsetY: 34,
        timestamp: 42,
      },
      sessionId: 7,
    })

    expect(sent).toContainEqual({ method: "Page.screencastFrameAck", params: { sessionId: 7 } })
    expect(frames[0]).toMatchObject({
      tabId: "tab-1",
      encoding: "base64",
      mime: "image/jpeg",
      data: "encoded-frame",
      metadata: {
        width: 640,
        height: 480,
        pageScaleFactor: 1,
        scrollOffsetX: 12,
        scrollOffsetY: 34,
        timestamp: 42000,
      },
    })

    await streamer.stop("tab-1")

    expect(sent).toContainEqual({ method: "Page.stopScreencast", params: undefined })
    expect(session.detach).toHaveBeenCalled()
  })
})
