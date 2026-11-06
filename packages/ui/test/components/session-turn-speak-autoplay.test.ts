import { afterEach, describe, expect, test } from "bun:test"
import {
  claimSpeakAutoplay,
  finishSpeakAutoplay,
  isSpeakTool,
  noteSpeakPartActive,
  rememberSpeakPlaybackPosition,
  resetSpeakAutoplayTrackerForTest,
  speakPlaybackPosition,
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
    expect(claimSpeakAutoplay("speak:part-history")).toBe(false)
  })

  test("a part seen active stays qualified across re-renders until finished", () => {
    noteSpeakPartActive("speak:part-live")
    expect(claimSpeakAutoplay("speak:part-live")).toBe(true)
    // Re-renders (turn settlement remount) keep the qualification so the
    // remounted card resumes playback instead of staying silent.
    expect(claimSpeakAutoplay("speak:part-live")).toBe(true)
    expect(claimSpeakAutoplay("speak:part-live")).toBe(true)
  })

  test("finishSpeakAutoplay clears the qualification when playback ends or pauses", () => {
    noteSpeakPartActive("speak:part-done")
    expect(claimSpeakAutoplay("speak:part-done")).toBe(true)
    finishSpeakAutoplay("speak:part-done")
    expect(claimSpeakAutoplay("speak:part-done")).toBe(false)
  })

  test("unrelated parts do not consume each other's claims", () => {
    noteSpeakPartActive("speak:part-a")
    noteSpeakPartActive("speak:part-b")
    expect(claimSpeakAutoplay("speak:part-b")).toBe(true)
    expect(claimSpeakAutoplay("speak:part-a")).toBe(true)
  })

  test("active parts observed across repeated pending renders stay claimable", () => {
    noteSpeakPartActive("speak:part-stream")
    // Streaming deltas re-render the pending card many times.
    noteSpeakPartActive("speak:part-stream")
    noteSpeakPartActive("speak:part-stream")
    expect(claimSpeakAutoplay("speak:part-stream")).toBe(true)
  })

  test("playback position is remembered and returned", () => {
    expect(speakPlaybackPosition("speak:part-x")).toBe(0)
    rememberSpeakPlaybackPosition("speak:part-x", 4.25)
    expect(speakPlaybackPosition("speak:part-x")).toBe(4.25)
    rememberSpeakPlaybackPosition("speak:part-x", 5)
    expect(speakPlaybackPosition("speak:part-x")).toBe(5)
  })

  test("reset clears active, qualified, and remembered positions", () => {
    noteSpeakPartActive("speak:part-doomed")
    rememberSpeakPlaybackPosition("speak:part-doomed", 3)
    resetSpeakAutoplayTrackerForTest()
    expect(claimSpeakAutoplay("speak:part-doomed")).toBe(false)
    expect(speakPlaybackPosition("speak:part-doomed")).toBe(0)
  })
})
