import { describe, expect, test } from "bun:test"
import { BrowserNavigationPolicy } from "../src/navigation-policy"

describe("Browser navigation policy", () => {
  test("allows same-origin page transitions but not agent returns to an old origin", () => {
    const policy = new BrowserNavigationPolicy({ allowUserNavigation: () => true })
    policy.begin("https://first.example/start", "agent")
    expect(policy.decide("https://first.example/start").allowed).toBe(true)
    policy.noteCommitted("https://first.example/start")
    expect(policy.decide("https://first.example/next").allowed).toBe(true)

    policy.begin("https://second.example/", "user")
    expect(policy.decide("https://second.example/").allowed).toBe(true)
    policy.noteCommitted("https://second.example/")
    expect(policy.decide("https://first.example/return").allowed).toBe(false)
  })

  test("allows cross-origin human gestures only during the bounded lease", () => {
    let now = 1_000
    const policy = new BrowserNavigationPolicy({ allowUserNavigation: () => true, now: () => now })
    policy.noteCommitted("https://first.example/")
    expect(policy.decide("https://second.example/").allowed).toBe(false)
    policy.noteUserGesture()
    expect(policy.decide("https://second.example/").allowed).toBe(true)
    now += 2_001
    expect(policy.decide("https://third.example/").allowed).toBe(false)
  })
})
