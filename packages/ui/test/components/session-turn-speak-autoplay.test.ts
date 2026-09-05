import { afterEach, describe, expect, test } from "bun:test"
import {
  claimSpeakAutoplay,
  isSpeakTool,
  noteSpeakPartActive,
  resetSpeakAutoplayTrackerForTest,
} from "../../src/components/session-turn-speak-autoplay"

afterEach(() => {
  resetSpeakAutoplayTrackerForTest()
})

describe("session-turn speak autoplay tracker", () => {
  test("identifies the speak tool only", () => {
    expect(isSpeakTool("speak")).toBe(true)
    expect(isSpeakTool("plugin__synergy-meme-plugin__generate_meme")).toBe(false)
    expect(isSpeakTool(undefined)).toBe(false)
  })

  test("a completed part that was never seen active does not autoplay (history replay)", () => {
    expect(claimSpeakAutoplay("part-history")).toBe(false)
  })

  test("a part seen active then claimed autoplays exactly once", () => {
    noteSpeakPartActive("part-live")
    expect(claimSpeakAutoplay("part-live")).toBe(true)
    // One-shot: the second completed render of the same part stays silent.
    expect(claimSpeakAutoplay("part-live")).toBe(false)
  })

  test("unrelated parts do not consume each other's claims", () => {
    noteSpeakPartActive("part-a")
    noteSpeakPartActive("part-b")
    expect(claimSpeakAutoplay("part-b")).toBe(true)
    expect(claimSpeakAutoplay("part-a")).toBe(true)
    expect(claimSpeakAutoplay("part-a")).toBe(false)
  })

  test("active parts observed across repeated renders stay claimable until completion", () => {
    noteSpeakPartActive("part-stream")
    // Streaming deltas re-render the pending card many times.
    noteSpeakPartActive("part-stream")
    noteSpeakPartActive("part-stream")
    expect(claimSpeakAutoplay("part-stream")).toBe(true)
  })

  test("an active part that errors or is superseded never autoplays after reset", () => {
    noteSpeakPartActive("part-doomed")
    resetSpeakAutoplayTrackerForTest()
    expect(claimSpeakAutoplay("part-doomed")).toBe(false)
  })
})
