import { describe, expect, test } from "bun:test"
import { shouldOpenProjectDisclosure } from "../../../src/components/sidebar/project-disclosure"

describe("shouldOpenProjectDisclosure", () => {
  test("waits for a local project's real sessions before changing the sidebar layout", () => {
    expect(
      shouldOpenProjectDisclosure({
        expanded: true,
        isSupplemental: false,
        navLoaded: false,
      }),
    ).toBe(false)
  })

  test("opens a local project once its session list is available", () => {
    expect(
      shouldOpenProjectDisclosure({
        expanded: true,
        isSupplemental: false,
        navLoaded: true,
      }),
    ).toBe(true)
  })

  test("keeps supplemental projects open so their load-sessions action remains available", () => {
    expect(
      shouldOpenProjectDisclosure({
        expanded: true,
        isSupplemental: true,
        navLoaded: false,
      }),
    ).toBe(true)
  })

  test("keeps collapsed projects closed even after their sessions have loaded", () => {
    expect(
      shouldOpenProjectDisclosure({
        expanded: false,
        isSupplemental: false,
        navLoaded: true,
      }),
    ).toBe(false)
  })
})
