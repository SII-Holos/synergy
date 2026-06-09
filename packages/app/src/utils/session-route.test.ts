import { describe, expect, test } from "bun:test"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { directorySessionRoute, globalSessionRoute } from "./session-route"

describe("session route helpers", () => {
  test("builds the canonical global session route", () => {
    expect(globalSessionRoute()).toBe(`/${base64Encode("global")}/session`)
  })

  test("normalizes a directory root to its session route", () => {
    const encodedDir = base64Encode("global")
    expect(directorySessionRoute(encodedDir)).toBe(`/${encodedDir}/session`)
  })

  test("falls back to the global session route when no directory is present", () => {
    expect(directorySessionRoute(undefined)).toBe(globalSessionRoute())
  })
})
